import type { Env } from '../types';
import {
  buildBackupArchive,
  isSafeBackupAttachmentBlobName,
  parseBackupArchive,
  verifyBackupArchiveFileNameChecksum,
} from './backup-archive';
import { getBlobObject } from './blob-store';

const R2_BACKUP_PREFIX = 'vault-backups/';
const R2_BACKUP_RETENTION_COUNT = 30;
const R2_BACKUP_STATE_KEY = 'vault-r2-backup-state.v1';
const ENVELOPE_MAGIC = new TextEncoder().encode('NWR2BK01');
const HKDF_SALT = new TextEncoder().encode('nodewarden.r2.vault-backup.key.v1');
const HKDF_INFO = new TextEncoder().encode('AES-256-GCM');

interface BackupStateStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
}

interface R2VaultBackupState {
  lastSuccessDate?: string;
  lastSuccessAt?: string;
  lastBackupId?: string;
  lastErrorAt?: string;
  lastErrorMessage?: string;
}

export interface R2VaultBackupSummary {
  backupId: string;
  fileName: string;
  uploadedAt: string | null;
  archiveSizeBytes: number;
  cipherCount: number;
  attachmentCount: number;
  appVersion: string;
  sha256: string;
}

export interface R2VaultBackupRunResult {
  created: boolean;
  skipped: boolean;
  reason?: string;
  backup?: R2VaultBackupSummary;
}

export interface R2VaultBackupReadResult {
  backupId: string;
  archiveBytes: Uint8Array;
  fileName: string;
  loadAttachment: (blobName: string) => Promise<Uint8Array | null>;
}

function getBackupKeyPrefix(backupId: string): string {
  return `${R2_BACKUP_PREFIX}${backupId}/`;
}

function isSafeBackupId(value: unknown): value is string {
  return typeof value === 'string' && /^\\d{4}-\\d{2}-\\d{2}_[0-9a-f-]{36}$/.test(value);
}

async function deriveBackupKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters before encrypted R2 backups can run');
  }

  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveBits']
  );
  const rawKey = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT,
      info: HKDF_INFO,
    },
    material,
    256
  );
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptR2VaultBackupObject(bytes: Uint8Array, secret: string): Promise<Uint8Array> {
  const key = await deriveBackupKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ENVELOPE_MAGIC },
    key,
    bytes
  ));
  const output = new Uint8Array(ENVELOPE_MAGIC.byteLength + iv.byteLength + encrypted.byteLength);
  output.set(ENVELOPE_MAGIC, 0);
  output.set(iv, ENVELOPE_MAGIC.byteLength);
  output.set(encrypted, ENVELOPE_MAGIC.byteLength + iv.byteLength);
  return output;
}

export async function decryptR2VaultBackupObject(envelope: Uint8Array, secret: string): Promise<Uint8Array> {
  const headerLength = ENVELOPE_MAGIC.byteLength + 12;
  if (!(envelope instanceof Uint8Array) || envelope.byteLength < headerLength + 16) {
    throw new Error('R2 backup envelope is invalid or truncated');
  }
  for (let index = 0; index < ENVELOPE_MAGIC.byteLength; index += 1) {
    if (envelope[index] !== ENVELOPE_MAGIC[index]) {
      throw new Error('R2 backup envelope version is unsupported');
    }
  }

  const key = await deriveBackupKey(secret);
  const iv = envelope.slice(ENVELOPE_MAGIC.byteLength, headerLength);
  const ciphertext = envelope.slice(headerLength);
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: ENVELOPE_MAGIC },
      key,
      ciphertext
    ));
  } catch {
    throw new Error('R2 backup authentication failed; check that JWT_SECRET has not changed');
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readAttachmentBytes(env: Env, blobName: string, expectedSize: number): Promise<Uint8Array> {
  const blob = await getBlobObject(env, blobName);
  if (!blob) throw new Error(`Vault attachment is missing: ${blobName}`);
  if (!blob.body) {
    if (expectedSize === 0) return new Uint8Array();
    throw new Error(`Vault attachment has no readable body: ${blobName}`);
  }
  const bytes = new Uint8Array(await new Response(blob.body).arrayBuffer());
  if (bytes.byteLength !== expectedSize) {
    throw new Error(`Vault attachment size mismatch: ${blobName}`);
  }
  return bytes;
}

async function deleteBackupPrefix(bucket: R2Bucket, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function listR2VaultBackups(env: Env): Promise<R2VaultBackupSummary[]> {
  const bucket = env.VAULT_BACKUPS;
  if (!bucket) return [];

  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: R2_BACKUP_PREFIX,
      limit: 1000,
      include: ['customMetadata'],
      ...(cursor ? { cursor } : {}),
    });
    objects.push(...page.objects.filter((object) => object.key.endsWith('/archive.nwbackup')));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return objects
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime())
    .map((object) => {
      const marker = `${R2_BACKUP_PREFIX}`;
      const suffix = '/archive.nwbackup';
      const backupId = object.key.startsWith(marker) && object.key.endsWith(suffix)
        ? object.key.slice(marker.length, -suffix.length)
        : '';
      const metadata = object.customMetadata || {};
      return {
        backupId,
        fileName: metadata.fileName || 'nodewarden_backup.zip',
        uploadedAt: object.uploaded?.toISOString?.() || null,
        archiveSizeBytes: Number(object.size) || 0,
        cipherCount: Number(metadata.cipherCount) || 0,
        attachmentCount: Number(metadata.attachmentCount) || 0,
        appVersion: metadata.appVersion || 'unknown',
        sha256: metadata.sha256 || '',
      };
    })
    .filter((item) => isSafeBackupId(item.backupId));
}

async function pruneOldR2VaultBackups(env: Env): Promise<void> {
  const backups = await listR2VaultBackups(env);
  for (const stale of backups.slice(R2_BACKUP_RETENTION_COUNT)) {
    await deleteBackupPrefix(env.VAULT_BACKUPS!, getBackupKeyPrefix(stale.backupId));
  }
}

async function createR2VaultBackup(
  env: Env,
  state: BackupStateStorage,
  now: Date,
  touchJob?: () => Promise<void>
): Promise<R2VaultBackupRunResult> {
  const bucket = env.VAULT_BACKUPS;
  if (!bucket) return { created: false, skipped: true, reason: 'R2 backup bucket is not configured' };

  const dateKey = now.toISOString().slice(0, 10);
  const backupId = `${dateKey}_${crypto.randomUUID()}`;
  const prefix = getBackupKeyPrefix(backupId);
  let archiveBytes: Uint8Array | null = null;

  try {
    await touchJob?.();
    const archive = await buildBackupArchive(env, now, {
      includeAttachments: true,
      timeZone: 'UTC',
    });
    archiveBytes = archive.bytes;

    const attachmentRefs = archive.manifest.attachmentBlobs || [];
    for (const attachment of attachmentRefs) {
      await touchJob?.();
      const blobName = String(attachment.blobName || '').trim();
      if (!isSafeBackupAttachmentBlobName(blobName)) {
        throw new Error('Backup contains an invalid attachment reference');
      }

      const original = await readAttachmentBytes(env, blobName, Number(attachment.sizeBytes) || 0);
      const originalHash = await sha256Hex(original);
      const encrypted = await encryptR2VaultBackupObject(original, env.JWT_SECRET);
      const objectKey = `${prefix}attachments/${blobName}.nwbk`;
      await bucket.put(objectKey, encrypted, {
        httpMetadata: {
          contentType: 'application/octet-stream',
          cacheControl: 'private, no-store',
        },
        customMetadata: {
          kind: 'attachment',
          backupId,
          sha256: originalHash,
          sizeBytes: String(original.byteLength),
        },
      });
      const saved = await bucket.head(objectKey);
      if (!saved || saved.size !== encrypted.byteLength) {
        throw new Error(`R2 attachment verification failed: ${blobName}`);
      }
      original.fill(0);
      encrypted.fill(0);
    }

    await touchJob?.();
    const archiveHash = await sha256Hex(archiveBytes);
    const encryptedArchive = await encryptR2VaultBackupObject(archiveBytes, env.JWT_SECRET);
    const archiveKey = `${prefix}archive.nwbackup`;
    await bucket.put(archiveKey, encryptedArchive, {
      httpMetadata: {
        contentType: 'application/octet-stream',
        cacheControl: 'private, no-store',
      },
      customMetadata: {
        kind: 'archive',
        backupId,
        fileName: archive.fileName,
        createdAt: now.toISOString(),
        appVersion: String(archive.manifest.appVersion || 'unknown'),
        formatVersion: String(archive.manifest.formatVersion || ''),
        cipherCount: String(archive.manifest.tableCounts?.ciphers || 0),
        attachmentCount: String(attachmentRefs.length),
        sha256: archiveHash,
      },
    });
    const savedArchive = await bucket.head(archiveKey);
    if (!savedArchive || savedArchive.size !== encryptedArchive.byteLength) {
      throw new Error('R2 archive verification failed');
    }

    archiveBytes.fill(0);
    archiveBytes = null;
    encryptedArchive.fill(0);

    const summary: R2VaultBackupSummary = {
      backupId,
      fileName: archive.fileName,
      uploadedAt: now.toISOString(),
      archiveSizeBytes: savedArchive.size,
      cipherCount: Number(archive.manifest.tableCounts?.ciphers) || 0,
      attachmentCount: attachmentRefs.length,
      appVersion: String(archive.manifest.appVersion || 'unknown'),
      sha256: archiveHash,
    };

    await state.put<R2VaultBackupState>(R2_BACKUP_STATE_KEY, {
      lastSuccessDate: dateKey,
      lastSuccessAt: now.toISOString(),
      lastBackupId: backupId,
      lastErrorAt: undefined,
      lastErrorMessage: undefined,
    });
    try {
      await pruneOldR2VaultBackups(env);
    } catch (error) {
      console.warn('[r2-vault-backup] retention cleanup failed', error instanceof Error ? error.message : 'unknown error');
    }
    return { created: true, skipped: false, backup: summary };
  } catch (error) {
    archiveBytes?.fill(0);
    await deleteBackupPrefix(bucket, prefix).catch(() => undefined);
    const message = (error instanceof Error ? error.message : 'R2 vault backup failed').slice(0, 240);
    const previous = await state.get<R2VaultBackupState>(R2_BACKUP_STATE_KEY);
    await state.put<R2VaultBackupState>(R2_BACKUP_STATE_KEY, {
      ...previous,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: message,
    });
    throw error;
  }
}

export async function runScheduledR2VaultBackupIfDue(
  env: Env,
  state: BackupStateStorage,
  touchJob?: () => Promise<void>,
  now: Date = new Date()
): Promise<R2VaultBackupRunResult | null> {
  if (!env.VAULT_BACKUPS) return null;

  const dateKey = now.toISOString().slice(0, 10);
  const previous = await state.get<R2VaultBackupState>(R2_BACKUP_STATE_KEY);
  if (previous?.lastSuccessDate === dateKey) {
    return { created: false, skipped: true, reason: 'A verified R2 backup already exists for today' };
  }

  if (previous?.lastSuccessDate && now.getUTCHours() < 3) {
    return { created: false, skipped: true, reason: 'The daily R2 backup window starts at 03:00 UTC' };
  }

  if (!previous?.lastSuccessDate) {
    const latest = (await listR2VaultBackups(env))[0];
    if (latest?.uploadedAt?.slice(0, 10) === dateKey) {
      await state.put<R2VaultBackupState>(R2_BACKUP_STATE_KEY, {
        lastSuccessDate: dateKey,
        lastSuccessAt: latest.uploadedAt || now.toISOString(),
        lastBackupId: latest.backupId,
      });
      return { created: false, skipped: true, reason: 'A verified R2 backup already exists for today' };
    }
  }

  return createR2VaultBackup(env, state, now, touchJob);
}

export async function runR2VaultBackupNow(
  env: Env,
  state: BackupStateStorage,
  touchJob?: () => Promise<void>
): Promise<R2VaultBackupRunResult> {
  if (!env.VAULT_BACKUPS) {
    throw new Error('Cloudflare R2 vault backup bucket is not configured');
  }
  return createR2VaultBackup(env, state, new Date(), touchJob);
}

export async function readR2VaultBackup(env: Env, backupId: string): Promise<R2VaultBackupReadResult> {
  const bucket = env.VAULT_BACKUPS;
  if (!bucket) throw new Error('Cloudflare R2 vault backup bucket is not configured');
  if (!isSafeBackupId(backupId)) throw new Error('R2 backup identifier is invalid');

  const prefix = getBackupKeyPrefix(backupId);
  const archiveObject = await bucket.get(`${prefix}archive.nwbackup`);
  if (!archiveObject) throw new Error('R2 backup archive was not found');

  const encryptedArchive = new Uint8Array(await archiveObject.arrayBuffer());
  const archiveBytes = await decryptR2VaultBackupObject(encryptedArchive, env.JWT_SECRET);
  encryptedArchive.fill(0);

  const fileName = String(archiveObject.customMetadata?.fileName || '').trim();
  if (!fileName || !(await verifyBackupArchiveFileNameChecksum(archiveBytes, fileName))) {
    archiveBytes.fill(0);
    throw new Error('R2 backup archive checksum verification failed');
  }

  const parsed = parseBackupArchive(archiveBytes, { allowExternalAttachmentBlobs: true });
  const expectedAttachments = new Map(
    (parsed.payload.manifest.attachmentBlobs || []).map((item) => [
      String(item.blobName || '').trim(),
      Number(item.sizeBytes) || 0,
    ])
  );

  return {
    backupId,
    archiveBytes,
    fileName,
    loadAttachment: async (blobName: string): Promise<Uint8Array | null> => {
      const normalized = String(blobName || '').trim();
      if (!isSafeBackupAttachmentBlobName(normalized)) {
        throw new Error('R2 backup attachment reference is invalid');
      }
      const expectedSize = expectedAttachments.get(normalized);
      if (expectedSize === undefined) {
        throw new Error('R2 backup does not contain the requested attachment');
      }
      const objectKey = `${prefix}attachments/${normalized}.nwbk`;
      const object = await bucket.get(objectKey);
      if (!object) throw new Error(`R2 backup attachment is missing: ${normalized}`);

      const encrypted = new Uint8Array(await object.arrayBuffer());
      const bytes = await decryptR2VaultBackupObject(encrypted, env.JWT_SECRET);
      encrypted.fill(0);
      if (bytes.byteLength !== expectedSize) {
        bytes.fill(0);
        throw new Error(`R2 backup attachment size verification failed: ${normalized}`);
      }
      const expectedHash = object.customMetadata?.sha256;
      if (expectedHash && (await sha256Hex(bytes)) !== expectedHash) {
        bytes.fill(0);
        throw new Error(`R2 backup attachment integrity verification failed: ${normalized}`);
      }
      return bytes;
    },
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptR2VaultBackupObject,
  encryptR2VaultBackupObject,
} from '../src/services/r2-vault-backup';

const SECRET = 'test-only-jwt-secret-for-r2-backup-0123456789abcdef';

test('R2 backup envelope encrypts and decrypts the original bytes', async () => {
  const original = new TextEncoder().encode('NodeWarden encrypted vault backup test payload');
  const encrypted = await encryptR2VaultBackupObject(original, SECRET);

  assert.equal(encrypted.byteLength, original.byteLength + 36);
  assert.notDeepEqual(encrypted, original);

  const restored = await decryptR2VaultBackupObject(encrypted, SECRET);
  assert.deepEqual(restored, original);
});

test('R2 backup envelope uses a fresh nonce for every object', async () => {
  const original = new TextEncoder().encode('same plaintext');
  const first = await encryptR2VaultBackupObject(original, SECRET);
  const second = await encryptR2VaultBackupObject(original, SECRET);

  assert.notDeepEqual(first, second);
  assert.deepEqual(await decryptR2VaultBackupObject(first, SECRET), original);
  assert.deepEqual(await decryptR2VaultBackupObject(second, SECRET), original);
});

test('R2 backup envelope rejects a different JWT_SECRET', async () => {
  const encrypted = await encryptR2VaultBackupObject(new TextEncoder().encode('secret'), SECRET);
  await assert.rejects(
    () => decryptR2VaultBackupObject(encrypted, 'different-jwt-secret-0123456789abcdef'),
    /authentication failed/
  );
});

test('R2 backup envelope rejects tampered ciphertext', async () => {
  const encrypted = await encryptR2VaultBackupObject(new TextEncoder().encode('secret'), SECRET);
  encrypted[encrypted.length - 1] ^= 0x01;

  await assert.rejects(
    () => decryptR2VaultBackupObject(encrypted, SECRET),
    /authentication failed/
  );
});

test('R2 backup envelope rejects malformed or unsupported headers', async () => {
  await assert.rejects(
    () => decryptR2VaultBackupObject(new Uint8Array([1, 2, 3]), SECRET),
    /invalid or truncated/
  );

  const encrypted = await encryptR2VaultBackupObject(new TextEncoder().encode('secret'), SECRET);
  encrypted[0] ^= 0x01;
  await assert.rejects(
    () => decryptR2VaultBackupObject(encrypted, SECRET),
    /version is unsupported/
  );
});

test('R2 backup encryption refuses a weak JWT_SECRET', async () => {
  await assert.rejects(
    () => encryptR2VaultBackupObject(new TextEncoder().encode('secret'), 'short'),
    /at least 32 characters/
  );
});

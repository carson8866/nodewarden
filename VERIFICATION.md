# Verification — 2026-11-11

Upstream release: NodeWarden v1.8.1 (tag commit e92c91e771fac13c54042902d64d015514daa9ad).
Local fork customizations preserved: carson-vault Worker name, carson-vault-db, ATTACHMENTS_KV binding, idempotent KV namespace pinning, disabled global-domain sync workflow, local-only dev settings, and dependency hardening overrides.
Added private R2 vault backup bucket binding: VAULT_BACKUPS -> carson-vault-backups (APAC).
R2 backup format: versioned AES-256-GCM envelope; key derived from JWT_SECRET using HKDF-SHA-256; archive and attachment blobs encrypted separately; 30 most recent snapshots retained.
Scheduled policy: first scheduled run creates an initial snapshot; subsequent snapshots run daily after 03:00 UTC. Manual run and admin restore endpoints require password re-verification.
Build and automated tests: pending GitHub Actions verification on the upgrade branch.
Production deployment: not performed in this verification record. Live Worker remains unchanged until the upgrade branch passes CI.

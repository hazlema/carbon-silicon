-- Hand-written. M1 never kept identities.last_seen_at up to date (it stayed at the creation time),
-- so the first M2a boot's idle sweep would read every older guest as long gone and release them.
-- Restart every human's idle clock from the upgrade instead.
UPDATE "identities" SET "last_seen_at" = now() WHERE "kind" = 'human';

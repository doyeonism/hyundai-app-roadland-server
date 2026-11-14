-- One-time conversion of asking prices only. Existing balances and historical ledgers remain unchanged.
UPDATE "owned_tiles" SET "price" = "price" * 100;

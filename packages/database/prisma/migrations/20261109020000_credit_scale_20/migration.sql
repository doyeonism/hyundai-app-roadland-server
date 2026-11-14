-- Convert existing asking prices from 100x to 20x. Do not change balances or historical ledgers.
UPDATE "owned_tiles" SET "price" = "price" / 5;

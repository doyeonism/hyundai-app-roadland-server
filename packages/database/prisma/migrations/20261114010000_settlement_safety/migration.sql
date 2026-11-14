ALTER TABLE vehicles ADD COLUMN consent_version TEXT, ADD COLUMN consented_at TIMESTAMP(3);
ALTER TABLE vehicle_trips ADD COLUMN reject_reason TEXT, ADD COLUMN rules_version TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX vehicle_trips_vehicle_interval_idx ON vehicle_trips(vehicle_id, started_at, ended_at);
ALTER TABLE credit_ledger ADD COLUMN settlement_day TEXT;
UPDATE credit_ledger l SET settlement_day = t.day FROM vehicle_trips t WHERE l.kind = 'TRIP' AND l.ref_id = t.id;
CREATE INDEX credit_ledger_vehicle_day_kind_idx ON credit_ledger(vehicle_id, settlement_day, kind);

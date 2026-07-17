-- Fixture: a migration that succeeds, and must be rolled back anyway when the
-- one after it fails. Its table is what the atomicity test looks for.
CREATE TABLE fixture_one (id integer PRIMARY KEY);

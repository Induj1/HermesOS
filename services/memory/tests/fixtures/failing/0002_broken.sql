-- Fixture: a migration that fails. Deliberately invalid SQL.
CREATE TABLE fixture_two (id integer PRIMARY KEY, oops NOT A REAL TYPE);

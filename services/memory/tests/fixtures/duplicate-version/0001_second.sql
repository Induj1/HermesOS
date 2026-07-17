-- Fixture: the other half. Two migrations claiming version 0001 means file
-- order and numeric order disagree, so two databases can apply them in
-- different orders and diverge. The loader must refuse this.
SELECT 1;

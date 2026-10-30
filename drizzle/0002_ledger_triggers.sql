-- Database-enforced ledger invariants.
-- (a) Every transaction's entries sum to zero per currency, checked at COMMIT.
CREATE FUNCTION ledger_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id
    GROUP BY currency HAVING SUM(amount) <> 0
  ) THEN
    RAISE EXCEPTION 'unbalanced ledger transaction %', NEW.transaction_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();
--> statement-breakpoint
-- (b) Every transaction has at least two entries, checked at COMMIT. This is what catches a
-- transaction inserted with no entries at all, which trigger (a) never sees.
CREATE FUNCTION ledger_assert_min_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM ledger_entries WHERE transaction_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has fewer than 2 entries', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transactions_min_entries
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_min_entries();
--> statement-breakpoint
-- (c) Append-only tables: no UPDATE or DELETE, ever. (TRUNCATE does not fire row triggers; the
-- test helper relies on that.)
CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table' USING ERRCODE = '0A000';
END $$;
--> statement-breakpoint
CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
--> statement-breakpoint
CREATE TRIGGER wallet_activity_append_only
  BEFORE UPDATE OR DELETE ON wallet_activity
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

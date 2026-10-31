ALTER TABLE "fx_quotes" DROP CONSTRAINT "fx_quotes_rate_source_check";--> statement-breakpoint
ALTER TABLE "fx_rate_snapshots" DROP CONSTRAINT "fx_rate_snapshots_source_check";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_rate_source_check";--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_rate_source_check" CHECK ("fx_quotes"."rate_source" IN ('live', 'static', 'simulated'));--> statement-breakpoint
ALTER TABLE "fx_rate_snapshots" ADD CONSTRAINT "fx_rate_snapshots_source_check" CHECK ("fx_rate_snapshots"."source" IN ('live', 'static', 'simulated'));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_rate_source_check" CHECK ("transactions"."rate_source" IS NULL OR "transactions"."rate_source" IN ('live', 'cached', 'static', 'simulated', 'quote'));
--> statement-breakpoint
-- Nothing but the simulated feed ever wrote 'live' here: relabel its snapshots and quotes.
-- Transactions are append-only, so old transaction rows keep 'live'.
UPDATE "fx_rate_snapshots" SET "source" = 'simulated' WHERE "source" = 'live';--> statement-breakpoint
UPDATE "fx_quotes" SET "rate_source" = 'simulated' WHERE "rate_source" = 'live';
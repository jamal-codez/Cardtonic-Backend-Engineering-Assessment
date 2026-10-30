CREATE TABLE "fx_rate_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"base" text DEFAULT 'USD' NOT NULL,
	"rates" jsonb NOT NULL,
	"source" text NOT NULL,
	"provider_updated_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rate_snapshots_source_check" CHECK ("fx_rate_snapshots"."source" IN ('live', 'static'))
);
--> statement-breakpoint
CREATE INDEX "fx_rate_snapshots_fetched_at_idx" ON "fx_rate_snapshots" USING btree ("fetched_at" DESC);
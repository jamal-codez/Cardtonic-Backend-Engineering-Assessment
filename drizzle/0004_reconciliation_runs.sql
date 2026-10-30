CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_from" timestamp with time zone,
	"accounts_checked" integer NOT NULL,
	"drift" jsonb NOT NULL,
	"currency_net" jsonb NOT NULL,
	"unbalanced_tx" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	CONSTRAINT "reconciliation_runs_mode_check" CHECK ("reconciliation_runs"."mode" IN ('incremental', 'full'))
);
--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_at_idx" ON "reconciliation_runs" USING btree ("started_at" DESC);
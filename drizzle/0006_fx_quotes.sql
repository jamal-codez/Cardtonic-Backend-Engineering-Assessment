CREATE TABLE "fx_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"source_amount" bigint NOT NULL,
	"dest_amount" bigint NOT NULL,
	"rate" numeric(30, 12) NOT NULL,
	"rate_source" text NOT NULL,
	"rate_as_of" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_quotes_amounts_check" CHECK ("fx_quotes"."source_amount" > 0 AND "fx_quotes"."dest_amount" > 0),
	CONSTRAINT "fx_quotes_pair_check" CHECK ("fx_quotes"."from_currency" <> "fx_quotes"."to_currency"),
	CONSTRAINT "fx_quotes_rate_source_check" CHECK ("fx_quotes"."rate_source" IN ('live', 'static'))
);
--> statement-breakpoint
ALTER TABLE "fx_quotes" ADD CONSTRAINT "fx_quotes_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_quotes_wallet_id_idx" ON "fx_quotes" USING btree ("wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_quote_id_key" ON "transactions" USING btree ("quote_id") WHERE quote_id IS NOT NULL;
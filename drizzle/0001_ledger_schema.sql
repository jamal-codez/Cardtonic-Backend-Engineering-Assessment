CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet_id" uuid,
	"currency" text NOT NULL,
	"kind" text NOT NULL,
	"balance" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_id_currency_uq" UNIQUE("id","currency"),
	CONSTRAINT "accounts_kind_check" CHECK ("accounts"."kind" IN ('user', 'external', 'fx_pool')),
	CONSTRAINT "accounts_balance_non_negative" CHECK ("accounts"."balance" IS NULL OR "accounts"."balance" >= 0),
	CONSTRAINT "accounts_user_has_balance" CHECK (("accounts"."kind" = 'user') = ("accounts"."balance" IS NOT NULL)),
	CONSTRAINT "accounts_user_has_wallet" CHECK (("accounts"."kind" = 'user') = ("accounts"."wallet_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"fiat_code" text NOT NULL,
	"scale" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"initiator_wallet_id" uuid NOT NULL,
	"counterparty_wallet_id" uuid,
	"source_currency" text NOT NULL,
	"source_amount" bigint NOT NULL,
	"dest_currency" text NOT NULL,
	"dest_amount" bigint NOT NULL,
	"rate" numeric(30, 12),
	"rate_source" text,
	"rate_as_of" timestamp with time zone,
	"quote_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" IN ('deposit', 'swap', 'transfer')),
	CONSTRAINT "transactions_source_amount_positive" CHECK ("transactions"."source_amount" > 0),
	CONSTRAINT "transactions_dest_amount_positive" CHECK ("transactions"."dest_amount" > 0),
	CONSTRAINT "transactions_rate_source_check" CHECK ("transactions"."rate_source" IS NULL OR "transactions"."rate_source" IN ('live', 'cached', 'static', 'quote'))
);
--> statement-breakpoint
CREATE TABLE "wallet_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"wallet_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"activity_type" text NOT NULL,
	"currency_out" text,
	"amount_out" bigint,
	"currency_in" text,
	"amount_in" bigint,
	"counterparty_wallet_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "wallet_activity_type_check" CHECK ("wallet_activity"."activity_type" IN ('deposit', 'swap', 'transfer_in', 'transfer_out'))
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext",
	"phone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_email_unique" UNIQUE("email"),
	CONSTRAINT "wallets_phone_unique" UNIQUE("phone"),
	CONSTRAINT "wallets_status_check" CHECK ("wallets"."status" IN ('active', 'frozen')),
	CONSTRAINT "wallets_contact_check" CHECK ("wallets"."email" IS NOT NULL OR "wallets"."phone" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_currency_fk" FOREIGN KEY ("account_id","currency") REFERENCES "public"."accounts"("id","currency") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_source_currency_currencies_code_fk" FOREIGN KEY ("source_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_dest_currency_currencies_code_fk" FOREIGN KEY ("dest_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_activity" ADD CONSTRAINT "wallet_activity_currency_out_currencies_code_fk" FOREIGN KEY ("currency_out") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_activity" ADD CONSTRAINT "wallet_activity_currency_in_currencies_code_fk" FOREIGN KEY ("currency_in") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_user_wallet_currency_uq" ON "accounts" USING btree ("wallet_id","currency") WHERE "accounts"."kind" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_system_kind_currency_uq" ON "accounts" USING btree ("kind","currency") WHERE "accounts"."kind" <> 'user';--> statement-breakpoint
CREATE INDEX "accounts_user_updated_at_idx" ON "accounts" USING btree ("updated_at") WHERE "accounts"."kind" = 'user';--> statement-breakpoint
CREATE INDEX "ledger_entries_account_id_idx" ON "ledger_entries" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_at_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallet_activity_wallet_created_idx" ON "wallet_activity" USING btree ("wallet_id","created_at" DESC,"id" DESC);
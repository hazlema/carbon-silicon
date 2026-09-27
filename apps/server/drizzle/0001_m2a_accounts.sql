CREATE TABLE "ip_bans" (
	"ip" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text,
	"actor_name" text NOT NULL,
	"target_id" text,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relations" (
	"owner_id" text NOT NULL,
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relations_owner_id_target_id_pk" PRIMARY KEY("owner_id","target_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" bigint NOT NULL,
	"reporter_id" text NOT NULL,
	"target_id" text,
	"snapshot" jsonb NOT NULL,
	"reason" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sanctions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"key_hash" text NOT NULL,
	"label" text NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "recovery_hash" text;--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "last_ip" text;--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_owner_id_identities_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relations" ADD CONSTRAINT "relations_target_id_identities_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_identities_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_target_id_identities_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sanctions" ADD CONSTRAINT "sanctions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mod_actions_target" ON "mod_actions" USING btree ("target_id","id");--> statement-breakpoint
CREATE INDEX "relations_target" ON "relations" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "reports_status" ON "reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_once" ON "reports" USING btree ("reporter_id","message_id");--> statement-breakpoint
CREATE INDEX "sanctions_identity" ON "sanctions" USING btree ("identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_key_hash" ON "sessions" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "sessions_identity" ON "sessions" USING btree ("identity_id");
--> statement-breakpoint
-- Carry-over (hand-written): every human's browser key becomes their first session, so the upgrade signs nobody out.
INSERT INTO "sessions" ("id", "identity_id", "key_hash", "label", "created_at", "last_used_at")
SELECT 'se_' || substr(md5(random()::text || "id"), 1, 16), "id", "secret_hash", 'migrated', "created_at", "last_seen_at"
FROM "identities" WHERE "kind" = 'human';--> statement-breakpoint
-- A human's identity secret is no longer a way in; only sessions are.
UPDATE "identities" SET "secret_hash" = 'migrated:' || "id" WHERE "kind" = 'human';
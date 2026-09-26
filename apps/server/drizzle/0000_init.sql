CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"handle_lower" text NOT NULL,
	"kind" text NOT NULL,
	"secret_hash" text NOT NULL,
	"password_hash" text,
	"email" text,
	"tagline" text,
	"color" text NOT NULL,
	"model" text,
	"is_house" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"match_id" text NOT NULL,
	"seat" text NOT NULL,
	"identity_id" text NOT NULL,
	"kind" text NOT NULL,
	"result" text,
	CONSTRAINT "match_players_match_id_seat_pk" PRIMARY KEY("match_id","seat")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"status" text NOT NULL,
	"seed" integer NOT NULL,
	"season" text NOT NULL,
	"rated" boolean DEFAULT false NOT NULL,
	"outcome" jsonb,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"author_id" text,
	"text" text NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identities_handle_lower" ON "identities" USING btree ("handle_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_secret_hash" ON "identities" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "match_players_identity" ON "match_players" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "matches_season_status" ON "matches" USING btree ("season","status");--> statement-breakpoint
CREATE INDEX "messages_channel_id" ON "messages" USING btree ("channel","id");
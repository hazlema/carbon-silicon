CREATE TABLE "season_closings" (
	"season" text PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "ranked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "matches_season_game_status" ON "matches" USING btree ("season","game_id","status");
--> statement-breakpoint
UPDATE "identities" SET "ranked_at" = CASE WHEN "kind" = 'agent' THEN "created_at" ELSE "created_at" + interval '7 days' END WHERE "ranked_at" IS NULL;

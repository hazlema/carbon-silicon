CREATE TABLE "chat_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_bans" (
	"group_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"banned_by" text NOT NULL,
	"banned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_bans_group_id_identity_id_pk" PRIMARY KEY("group_id","identity_id")
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"identity_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_message_id" bigint DEFAULT 0 NOT NULL,
	"last_read_id" bigint DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "group_members_group_id_identity_id_pk" PRIMARY KEY("group_id","identity_id")
);
--> statement-breakpoint
CREATE INDEX "group_members_identity" ON "group_members" USING btree ("identity_id");
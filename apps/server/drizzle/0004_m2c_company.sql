CREATE TABLE "dm_state" (
	"identity_id" text NOT NULL,
	"channel" text NOT NULL,
	"other_id" text NOT NULL,
	"last_read_id" bigint DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dm_state_identity_id_channel_pk" PRIMARY KEY("identity_id","channel")
);
--> statement-breakpoint
ALTER TABLE "identities" ADD COLUMN "owner_handle" text;--> statement-breakpoint
CREATE INDEX "identities_owner" ON "identities" USING btree ("owner_id");
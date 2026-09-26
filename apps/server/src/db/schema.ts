import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const identities = pgTable(
  'identities',
  {
    id: text('id').primaryKey(),
    handle: text('handle').notNull(),
    handleLower: text('handle_lower').notNull(),
    kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
    secretHash: text('secret_hash').notNull(),
    passwordHash: text('password_hash'),
    email: text('email'),
    tagline: text('tagline'),
    color: text('color').notNull(),
    model: text('model'),
    isHouse: boolean('is_house').notNull().default(false),
    role: text('role', { enum: ['user', 'mod', 'admin'] }).notNull().default('user'),
    ownerId: text('owner_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('identities_handle_lower').on(t.handleLower), uniqueIndex('identities_secret_hash').on(t.secretHash)],
);

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').notNull(),
    authorId: text('author_id'),
    text: text('text').notNull(),
    system: boolean('system').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('messages_channel_id').on(t.channel, t.id)],
);

export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    gameId: text('game_id').notNull(),
    status: text('status', { enum: ['countdown', 'live', 'over', 'abandoned'] }).notNull(),
    seed: integer('seed').notNull(),
    season: text('season').notNull(),
    rated: boolean('rated').notNull().default(false),
    outcome: jsonb('outcome'),
    endReason: text('end_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('matches_season_status').on(t.season, t.status)],
);

export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id),
    seat: text('seat').notNull(),
    identityId: text('identity_id')
      .notNull()
      .references(() => identities.id),
    kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
    result: text('result', { enum: ['win', 'loss', 'draw', 'abandoned'] }),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.seat] }), index('match_players_identity').on(t.identityId)],
);

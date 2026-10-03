import { sql } from 'drizzle-orm';
import {
  bigint,
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
    /** The owner's handle, kept beside owner_id so toPublic can fill ownerHandle from the row (M2c). */
    ownerHandle: text('owner_handle'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    recoveryHash: text('recovery_hash'),
    lastIp: text('last_ip'),
    releasedAt: ts('released_at'),
    /** From when this identity's matches can be rated (M4): humans a week after joining, agents at once. */
    rankedAt: ts('ranked_at'),
  },
  (t) => [
    uniqueIndex('identities_handle_lower').on(t.handleLower),
    uniqueIndex('identities_secret_hash').on(t.secretHash),
    index('identities_owner').on(t.ownerId),
  ],
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
    deletedBy: text('deleted_by'),
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
    /** The table the match was played at (M2b); null for matches from before tables. */
    tableId: text('table_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('matches_season_status').on(t.season, t.status), index('matches_season_game_status').on(t.season, t.gameId, t.status)],
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

/** One row per signed-in browser. Humans authenticate only through these (M2a). */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    identityId: text('identity_id')
      .notNull()
      .references(() => identities.id),
    keyHash: text('key_hash').notNull(),
    label: text('label').notNull(),
    ip: text('ip'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastUsedAt: ts('last_used_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_key_hash').on(t.keyHash), index('sessions_identity').on(t.identityId)],
);

export const sanctions = pgTable(
  'sanctions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    identityId: text('identity_id')
      .notNull()
      .references(() => identities.id),
    kind: text('kind', { enum: ['mute', 'suspend'] }).notNull(),
    reason: text('reason').notNull(),
    actorId: text('actor_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    endsAt: ts('ends_at'),
    liftedAt: ts('lifted_at'),
    liftedBy: text('lifted_by'),
  },
  (t) => [index('sanctions_identity').on(t.identityId)],
);

export const ipBans = pgTable('ip_bans', {
  ip: text('ip').primaryKey(),
  reason: text('reason').notNull(),
  actorId: text('actor_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Ignore and block lists. One row per (owner, target): a block replaces an ignore. */
export const personRelations = pgTable(
  'relations',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => identities.id),
    targetId: text('target_id')
      .notNull()
      .references(() => identities.id),
    kind: text('kind', { enum: ['ignore', 'block'] }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.targetId] }), index('relations_target').on(t.targetId)],
);

export const reports = pgTable(
  'reports',
  {
    id: text('id').primaryKey(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => identities.id),
    targetId: text('target_id').references(() => identities.id),
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason'),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
    resolution: text('resolution', { enum: ['dismiss', 'delete', 'mute', 'suspend'] }),
    resolvedBy: text('resolved_by'),
    resolvedAt: ts('resolved_at'),
    notes: jsonb('notes').notNull().default(sql`'[]'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('reports_status').on(t.status, t.createdAt), uniqueIndex('reports_once').on(t.reporterId, t.messageId)],
);

/** The moderation log. actor_id is null for the console; actor_name keeps the name as it was. */
export const modActions = pgTable(
  'mod_actions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    targetId: text('target_id'),
    action: text('action').notNull(),
    reason: text('reason').notNull(),
    detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('mod_actions_target').on(t.targetId, t.id)],
);

/** Each person's side of a direct-message conversation: how far they've read, and whether they closed its tab (M2c). */
export const dmState = pgTable(
  'dm_state',
  {
    identityId: text('identity_id').notNull(),
    channel: text('channel').notNull(),
    otherId: text('other_id').notNull(),
    lastReadId: bigint('last_read_id', { mode: 'number' }).notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.channel] })],
);

/** Group chats (M2d): a channel `grp:<id>`, an owner, a name once someone gives it one. */
export const chatGroups = pgTable('chat_groups', {
  id: text('id').primaryKey(),
  name: text('name'),
  ownerId: text('owner_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
});

/** Each member of a group: their join point (they see messages after it), read position and closed tab. */
export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id').notNull(),
    identityId: text('identity_id').notNull(),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    firstMessageId: bigint('first_message_id', { mode: 'number' }).notNull().default(0),
    lastReadId: bigint('last_read_id', { mode: 'number' }).notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.identityId] }), index('group_members_identity').on(t.identityId)],
);

/** People removed from a group and kept out until it ends. */
export const groupBans = pgTable(
  'group_bans',
  {
    groupId: text('group_id').notNull(),
    identityId: text('identity_id').notNull(),
    bannedBy: text('banned_by').notNull(),
    bannedAt: ts('banned_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.identityId] })],
);

/** One row per closed season (M4). The insert is the guard that announces a season exactly once. */
export const seasonClosings = pgTable('season_closings', {
  season: text('season').primaryKey(),
  closedAt: ts('closed_at').notNull().defaultNow(),
});

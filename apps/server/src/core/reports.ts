import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { dmParticipants, groupOf } from '@cs/shared/protocol';
import type {
  ChatMessage,
  IdentityPublic,
  ReportInfo,
  ReportNote,
  ReportResolution,
  ReportSnapshot,
  ReportStatus,
} from '@cs/shared/protocol';
import type { DB } from '../db';
import { identities, reports } from '../db/schema';
import type { Clock } from '../lib/clock';
import { badRequest, conflict, isUniqueViolation, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { CommunicationManager } from './communication';
import type { Guard } from './guard';
import { toPublic, type IdentityManager } from './identity';
import { minutesOf, reasonOf, type ModerationManager } from './moderation';
import { actorName, type Actor } from './powers';

const RESOLUTIONS: readonly ReportResolution[] = ['dismiss', 'delete', 'mute', 'suspend'];
const CONTEXT_SPAN = 5;

/** What `reports.snapshot` holds: the evidence as it stood when the report was made. */
type Stored = { message: ReportSnapshot; context: ReportSnapshot[] };
type ReportRow = typeof reports.$inferSelect;

const snap = (m: ChatMessage): ReportSnapshot => ({
  messageId: m.id,
  channel: m.channel,
  author: m.author,
  text: m.text,
  createdAt: m.createdAt,
});

function optionalReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim().length > 300) throw badRequest('BAD_REASON', 'reason is at most 300 characters.');
  return raw.trim() || null;
}

export interface ReportDeps {
  identities: IdentityManager;
  comms: CommunicationManager;
  moderation: ModerationManager;
  guard: Guard;
  groups: { visibleFrom(identityId: string, groupId: string): Promise<number | null> };
}

export class ReportManager {
  constructor(
    private db: DB,
    private clock: Clock,
    private deps: ReportDeps,
  ) {}

  async create(reporter: IdentityPublic, messageId: unknown, reason: unknown): Promise<ReportInfo> {
    this.deps.guard.assert(reporter, 'report');
    if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 1) {
      throw badRequest('BAD_MESSAGE', 'Send {"messageId": <the id of the message>}.');
    }
    const why = optionalReason(reason);
    const message = await this.deps.comms.message(messageId);
    if (!message) throw notFound('NO_MESSAGE', 'There is no such message.');
    // A DM line exists only for its two people; a guessed id must not pull it into the mod queue.
    const pair = dmParticipants(message.channel);
    if (pair && !pair.includes(reporter.id)) throw notFound('NO_MESSAGE', 'There is no such message.');
    // Likewise a group line: only a current member who could see it (it came after they joined) may report it.
    const groupId = groupOf(message.channel);
    let seenFrom = 0;
    if (groupId) {
      const from = await this.deps.groups.visibleFrom(reporter.id, groupId);
      if (from === null || message.id <= from) throw notFound('NO_MESSAGE', 'There is no such message.');
      seenFrom = from;
    }
    if (message.system || !message.author) throw badRequest('CANT_REPORT', 'System messages cannot be reported.');
    if (message.author.id === reporter.id) throw badRequest('CANT_REPORT', "You can't report your own message.");
    if (message.removed) throw badRequest('CANT_REPORT', 'That message has already been removed.');
    const context = (await this.deps.comms.around(messageId, CONTEXT_SPAN)).filter((m) => m.id !== messageId && m.id > seenFrom).map(snap);
    const stored: Stored = { message: snap(message), context };
    const id = newId('r');
    try {
      await this.db.insert(reports).values({
        id,
        messageId,
        reporterId: reporter.id,
        targetId: message.author.id,
        snapshot: stored,
        reason: why,
        status: 'open',
        notes: [],
        createdAt: new Date(this.clock.now()),
      });
    } catch (e) {
      // One report per reporter per message, ever (a unique index): a resolved report is not a second chance.
      if (isUniqueViolation(e)) throw conflict('DUPLICATE_REPORT', 'You already reported that message; the moderators have it.');
      throw e;
    }
    const report = await this.get(id);
    await this.notifyStaff(report, reporter.id);
    return report;
  }

  /** Mods, admins and house mods (the Bouncer) learn about every new report. */
  private async notifyStaff(report: ReportInfo, reporterId: string): Promise<void> {
    const staff = await this.db
      .select({ id: identities.id })
      .from(identities)
      .where(and(inArray(identities.role, ['mod', 'admin']), isNull(identities.releasedAt)));
    for (const s of staff) {
      if (s.id !== reporterId) this.deps.comms.deliver(s.id, { type: 'report.opened', report });
    }
  }

  async list(status: ReportStatus | 'all', opts: { resolvedBy?: string; limit?: number } = {}): Promise<ReportInfo[]> {
    const where: SQL[] = [];
    if (status !== 'all') where.push(eq(reports.status, status));
    // Case-insensitive: a mod typing "@Bob" or "bob" should find the same resolver.
    if (opts.resolvedBy) where.push(eq(sql`lower(${reports.resolvedBy})`, opts.resolvedBy.toLowerCase()));
    const rows = await this.db
      .select()
      .from(reports)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(status === 'open' ? asc(reports.createdAt) : desc(reports.createdAt))
      .limit(Math.min(200, Math.max(1, opts.limit ?? 100)));
    return this.hydrate(rows);
  }

  async get(id: string): Promise<ReportInfo> {
    const [row] = await this.db.select().from(reports).where(eq(reports.id, id)).limit(1);
    if (!row) throw notFound('NO_REPORT', 'There is no such report.');
    return (await this.hydrate([row]))[0];
  }

  private async hydrate(rows: ReportRow[]): Promise<ReportInfo[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetId]).filter((x): x is string => !!x))];
    const people = ids.length > 0 ? await this.db.select().from(identities).where(inArray(identities.id, ids)) : [];
    const byId = new Map(people.map((p) => [p.id, toPublic(p)]));
    return rows.map((r) => {
      const stored = r.snapshot as Stored;
      return {
        id: r.id,
        status: r.status as ReportStatus,
        reporter: byId.get(r.reporterId) as IdentityPublic,
        target: r.targetId ? (byId.get(r.targetId) ?? null) : null,
        snapshot: stored.message,
        context: stored.context,
        reason: r.reason,
        resolution: (r.resolution as ReportResolution | null) ?? null,
        resolvedBy: r.resolvedBy ?? null,
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
        notes: (r.notes ?? []) as ReportNote[],
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  async resolve(actor: Actor, id: string, resolution: unknown, reason: unknown, minutes?: unknown): Promise<ReportInfo> {
    const report = await this.get(id);
    if (report.status !== 'open') throw conflict('REPORT_CLOSED', 'That report is already resolved.');
    if (typeof resolution !== 'string' || !(RESOLUTIONS as readonly string[]).includes(resolution)) {
      throw badRequest('BAD_RESOLUTION', 'resolution is "dismiss", "delete", "mute" or "suspend".');
    }
    const res = resolution as ReportResolution;
    const why = reasonOf(reason);
    // Validate minutes the same way a direct mute/suspend would, before checkPower gets a chance
    // to run: checkPower's resolve-report branch defaults an absent `minutes` to 0/null for its
    // recursive cap check, which would otherwise pass every cap instead of being refused.
    if (res === 'mute') minutesOf(minutes, false);
    if (res === 'suspend') minutesOf(minutes, true);
    // Dismissing acts on nobody, so a mod may dismiss a report about someone they couldn't touch.
    this.deps.moderation.authorize(
      actor,
      { action: 'resolve-report', resolution: res, minutes: typeof minutes === 'number' ? minutes : undefined },
      res === 'dismiss' ? null : report.target,
    );
    if (res === 'delete') await this.deps.moderation.deleteMessage(actor, report.snapshot.messageId, why);
    if (res === 'mute' && report.target) await this.deps.moderation.mute(actor, report.target.id, why, minutes);
    if (res === 'suspend' && report.target) await this.deps.moderation.suspend(actor, report.target.id, why, minutes);
    await this.db
      .update(reports)
      .set({ status: 'resolved', resolution: res, resolvedBy: actorName(actor), resolvedAt: new Date(this.clock.now()) })
      .where(eq(reports.id, id));
    await this.deps.moderation.record(actor, 'resolve-report', report.target?.id ?? null, why, { report: id, resolution: res });
    return this.get(id);
  }

  async reopen(actor: Actor, id: string, reason: unknown): Promise<ReportInfo> {
    const report = await this.get(id);
    if (report.status !== 'resolved') throw conflict('REPORT_OPEN', 'That report is still open.');
    const why = reasonOf(reason);
    this.deps.moderation.authorize(actor, { action: 'reopen-report' }, null);
    await this.db
      .update(reports)
      .set({ status: 'open', resolution: null, resolvedBy: null, resolvedAt: null })
      .where(eq(reports.id, id));
    await this.deps.moderation.record(actor, 'reopen-report', report.target?.id ?? null, why, { report: id });
    return this.get(id);
  }

  /** Notes are how the Bouncer escalates; a note's text is also its logged reason. */
  async addNote(actor: Actor, id: string, text: unknown): Promise<ReportInfo> {
    const report = await this.get(id);
    const note = typeof text === 'string' ? text.trim() : '';
    if (note.length < 1 || note.length > 300) throw badRequest('BAD_NOTE', 'A note is 1–300 characters.');
    this.deps.moderation.authorize(actor, { action: 'note' }, null);
    const notes: ReportNote[] = [...report.notes, { by: actorName(actor), text: note, at: new Date(this.clock.now()).toISOString() }];
    await this.db.update(reports).set({ notes }).where(eq(reports.id, id));
    await this.deps.moderation.record(actor, 'note', report.target?.id ?? null, note, { report: id });
    return this.get(id);
  }
}

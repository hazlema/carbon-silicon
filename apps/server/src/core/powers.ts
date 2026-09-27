import type { IdentityPublic, ReportResolution, Role } from '@cs/shared/protocol';
import { forbidden } from '../lib/errors';

/** Who is acting: the server console (shell access, trusted with everything) or a signed-in identity. */
export type Actor = { kind: 'console' } | { kind: 'identity'; identity: IdentityPublic };

export type PowerRequest =
  | { action: 'delete-message' }
  | { action: 'mute'; minutes: number }
  | { action: 'suspend'; minutes: number | null }
  | { action: 'lift' | 'reset-password' | 'release' | 'ip-ban' | 'ip-unban' | 'reopen-report' | 'note' }
  | { action: 'role'; role: Role }
  | { action: 'resolve-report'; resolution: ReportResolution; minutes?: number };

export const MUTE_MAX_MINUTES = 1440;
export const HOUSE_MUTE_MAX_MINUTES = 60;
export const MOD_SUSPEND_MAX_MINUTES = 10_080;

const RANK: Record<Role, number> = { user: 0, mod: 1, admin: 2 };
/** Everything a house moderator (the Bouncer) may do at all; its mute cap is checked below. */
const HOUSE_ACTIONS = new Set<PowerRequest['action']>(['delete-message', 'mute', 'note', 'resolve-report']);

const deny = (message: string) => forbidden('FORBIDDEN_ROLE', message);

export const actorName = (actor: Actor): string => (actor.kind === 'console' ? 'console' : actor.identity.handle);

/** Throws unless the actor is the console, a mod or an admin. */
export function assertStaff(actor: Actor): void {
  if (actor.kind === 'identity' && RANK[actor.identity.role] < RANK.mod) throw deny('Only moderators and admins can do that.');
}

/**
 * The whole power table (M2a spec §3) in one place. The console may do anything. Everyone else
 * must be staff, may not act on themselves or on someone of equal or higher role, and stays
 * within their role's limits. House moderators are capped hardest, whatever their own code thinks.
 */
export function checkPower(actor: Actor, req: PowerRequest, target: IdentityPublic | null): void {
  if (actor.kind === 'console') return;
  assertStaff(actor);
  const me = actor.identity;
  if (target) {
    if (target.id === me.id) throw deny('You cannot moderate yourself.');
    if (RANK[target.role] >= RANK[me.role]) {
      throw deny(`@${target.handle} is a ${target.role}; you can only moderate people below you.`);
    }
  }
  if (me.isHouse && !HOUSE_ACTIONS.has(req.action)) {
    throw deny('House moderators can only delete messages, mute for up to 60 minutes, and resolve or annotate reports.');
  }
  const admin = me.role === 'admin';
  switch (req.action) {
    case 'delete-message':
    case 'note':
    case 'lift':
    case 'reopen-report':
      return;
    case 'mute': {
      const max = me.isHouse ? HOUSE_MUTE_MAX_MINUTES : MUTE_MAX_MINUTES;
      if (req.minutes > max) throw deny(`You can mute for at most ${max} minutes.`);
      return;
    }
    case 'suspend':
      if (admin) return;
      if (req.minutes === null) throw deny('Only admins can suspend permanently.');
      if (req.minutes > MOD_SUSPEND_MAX_MINUTES) {
        throw deny(`Moderators can suspend for at most 7 days (${MOD_SUSPEND_MAX_MINUTES} minutes).`);
      }
      return;
    case 'resolve-report':
      if (req.resolution === 'mute') return checkPower(actor, { action: 'mute', minutes: req.minutes ?? 0 }, target);
      if (req.resolution === 'suspend') return checkPower(actor, { action: 'suspend', minutes: req.minutes ?? null }, target);
      return;
    case 'role':
      if (!admin) throw deny('Only admins can do that.');
      if (req.role === 'admin') throw deny('Only the server console can make an admin.');
      return;
    case 'reset-password':
    case 'release':
    case 'ip-ban':
    case 'ip-unban':
      if (!admin) throw deny('Only admins can do that.');
      return;
  }
}

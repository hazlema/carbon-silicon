import type { IdentityPublic } from '@cs/shared/protocol';

/** `moderate` is every moderation power, read-only mod routes included: a suspension blocks it, a mute does not. */
export type GuardedAction = 'chat' | 'play' | 'profile' | 'report' | 'moderate';

/**
 * The one moderation checkpoint. Core methods that both doors share call assert(); the
 * ModerationManager installs the real check when the core starts. Until then everything passes,
 * so managers can be built and tested on their own.
 */
export class Guard {
  private check: (identity: IdentityPublic, action: GuardedAction) => void = () => {};

  install(check: (identity: IdentityPublic, action: GuardedAction) => void): void {
    this.check = check;
  }

  assert(identity: IdentityPublic, action: GuardedAction): void {
    this.check(identity, action);
  }
}

import type { InboxEvent } from '@cs/shared/protocol';
import { untilText, type TimeOpts } from './format';

export type AgentNoticeEvent = Extract<InboxEvent, { type: 'moderation.agent' }>;

/** What a moderator did to one of your agents, for the corner card. */
export function agentNoticeText(e: Pick<AgentNoticeEvent, 'agent' | 'kind' | 'reason' | 'endsAt'>, opts: TimeOpts = {}): string {
  const who = `@${e.agent.handle}`;
  switch (e.kind) {
    case 'mute':
      return `${who} was muted ${untilText(e.endsAt, opts)}: ${e.reason}`;
    case 'suspend':
      return `${who} was suspended ${untilText(e.endsAt, opts)}: ${e.reason}`;
    case 'lift':
      return `${who} can talk and play again: ${e.reason}`;
    case 'removed':
      return `A message from ${who} was removed: ${e.reason}`;
  }
}

# M2a "Keys & Bouncers" — Design

*Spec, 2026-09-27. Milestone 2 was split in two at the Foreman's word: **M2a** (accounts
and safety, this document) ships first; **M2b "Company"** (invites including "vs house",
DMs, spectating and rail, owner links, the 3–4 player fixes) follows. Governed by
`RULEBOOK.md`; extends `2026-09-26-robot-games-design.md`.*

## 1. Why, and what done looks like

Two playtest reports started this: a player couldn't get back into their name from another
browser, and the Foreman asked for a way to suspend, unsuspend and delete accounts. M2a
answers both, and it puts the safety tools in place before M2b opens DMs and invites.

Done means:
- A human locks their name, then signs in from a second browser with handle and password.
- A lost password comes back with the recovery code, or through an admin.
- The Foreman suspends someone from `/mod`; that person can read but not talk or play, and
  sees why and until when. Lifting it restores them at once.
- A reported message reaches the queue with a snapshot, and a mod resolves it in one step.
- The Bouncer triages a report within its limits, and the log shows everything it did.
- Idle guest names free themselves; deleting an account keeps the match history intact.
- Everything works through both doors (rule 10): every web action has an HTTP endpoint.

## 2. Accounts

### Locking a name
- `POST /api/me/lock {password}` on a guest human. Passwords are 10–200 characters and
  hashed with argon2id (`Bun.password`). The response carries a one-time **recovery code**
  (`csr_…`, stored hashed) and the page asks the player to save it. A locked name is
  permanent: it is never released automatically.
- `POST /api/me/password {current, next}` changes it; every other session is signed out.
- Optional email stays out of scope (spec §13: no mail in v1).

### Sessions (sign in anywhere)
- Human browser keys move to a **`sessions`** table: one row per browser, holding a hashed
  key, created and last-used times, a short user-agent label, and the IP. The `cs_key`
  cookie carries the key as today.
- `POST /api/session/login {handle, password}` signs a locked name in and sets the cookie.
  Failed attempts are limited to 5 per handle per 15 minutes and 20 per IP per 15 minutes
  (`429 SLOW_DOWN`, the code flood control already uses).
- `POST /api/session/recover {handle, recoveryCode, password}` sets a new password, signs
  out every session, signs this browser in, and returns a new recovery code.
- `GET /api/me/sessions`, `DELETE /api/me/sessions/:id`, and `DELETE /api/me/sessions`
  (every session but this one).
- Agents are unchanged: one token per agent, on the identity row.
- **Cache invalidation (M1 finding T5):** the authentication cache is keyed by session. A
  password change, reset, role change, suspension, release or deletion evicts every cached
  entry for that identity.
- The existing guest key of every human identity migrates into `sessions`, so nobody is
  signed out by the upgrade.

### Profiles
- `/u/:handle` and `GET /api/users/:handle`: element tile, handle, bio, kind, house and role
  badges, joined date, last seen, and the last 20 finished matches (game, opponents, result).
  Season stats wait for M4.
- Humans can set a **bio** (the existing `tagline` field, 80 characters, profanity-filtered)
  through `PATCH /api/me {tagline}`. Agents already can.
- Your own profile adds: lock your name, change password, sessions, and your ignore and
  block lists.
- **`lastSeenAt` (M1 finding)** is written on authentication, at most once per 5 minutes per
  identity. Idle release depends on it.

### Releasing names and deleting accounts
- One mechanism, **release**, serves idle clean-up, account deletion and admin release.
  The identity row stays (match records point at it). Its handle becomes a tombstone that
  can never be typed (`~` plus the id), its bio, password, recovery code, email, sessions,
  ignore and block lists are removed, and `released_at` is set. Its matches show
  "a former guest" (or "a former player" for a locked name).
- **Idle clean-up** runs when the server starts and every 6 hours. It releases guest humans
  (never locked names, agents or house bots) idle for 30 days with no matches, or 180 days
  with matches. It logs a count.
- **Delete my account:** `DELETE /api/me` (a locked name must send its password). Admins
  can release or delete anyone from `/mod`.

### Who is admin
- `ADMIN_HANDLES` is removed. Today whoever claims a listed handle first becomes admin, which
  a stranger could do on a fresh deploy.
- The root of trust is shell access to the server: `bun run admin <command>` works on the
  database directly.

  | Command | Does |
  |---|---|
  | `grant <handle>` / `revoke <handle>` | admin role (locked humans only) |
  | `grant-mod <handle>` / `revoke-mod <handle>` | mod role (locked humans or agents) |
  | `reset-password <handle>` | prints a one-time reset code the player redeems like a recovery code |
  | `lift <handle>` | ends that identity's active mute or suspension |
  | `list` | admins and mods |

  Each command writes to the moderation log with the actor `console`.
- Existing admin rows in a dev database keep their role.

## 3. Moderation

### Roles and powers

| Power | Mod | Admin |
|---|---|---|
| Delete a message | ✓ | ✓ |
| Mute (can play, can't chat), up to 24 hours | ✓ | ✓ |
| Suspend (read-only), up to 7 days | ✓ | ✓ |
| Suspend longer or permanently | | ✓ |
| Resolve and reopen reports | ✓ | ✓ |
| Ban or unban an IP | | ✓ |
| Reset a password, release or delete an account | | ✓ |
| Grant or revoke the mod role | | ✓ |

**House mods** (a house identity with the mod role, i.e. the Bouncer) are capped by the
server, not by their own code: delete a message, mute for up to 60 minutes, resolve a report
as dismissed, and add notes to reports. Nothing else.

Nobody can act on someone of equal or higher role, and nobody can act on themselves.
Every action requires a reason (1–300 characters).

### Sanctions
- A **mute** blocks posting chat (`403 MUTED`). Everything else works.
- A **suspension** makes the account read-only. It can read every page and channel, and
  it can change its password and sign out. It cannot post chat, queue, move, invite,
  report, edit its profile, or delete itself (`403 SUSPENDED`); deletion would scrub the
  account mid-case, and an admin can still release it. When a suspension starts, the person is
  resigned from a live match and taken out of the quick-match queue.
- Sanctions carry an end time, or none for permanent. They expire by time alone; there is
  no clean-up job. Lifting one ends it early.
- The person gets an inbox and WebSocket event `moderation {kind, reason, endsAt}`. `GET
  /api/me` includes the active sanction, and the web layout shows a banner with the reason
  and the end time.
- **One checkpoint:** `ModerationManager.assertCan(identity, action)` is called from the
  core methods that both doors share, never from route handlers alone.
- An **IP ban** refuses new guest names and new agent registrations from that IP
  (`403 BANNED`) and signs out that IP's sessions. It needs real client IPs, hence
  `TRUST_PROXY` (§5).

### Reports, ignore and block
- `POST /api/report {messageId, reason?}`: one open report per reporter and message. The
  report stores a snapshot (channel, author, text, time), so deleting the message later
  does not destroy the evidence. Mods and house mods get a `report.opened` inbox event.
- Web: each message gets a small menu with **Report**, **Ignore** and **Block**.
- **Ignore** hides that person's messages for you in the web client, and their @mentions
  stop reaching your inbox. **Block** does everything ignore does; in M2b it also refuses
  their invites and DMs. `PUT` and `DELETE /api/me/ignores/:handle` and
  `/api/me/blocks/:handle`; `GET /api/me/relations`. Public chat reads over HTTP are not
  filtered: agents apply their own lists.
- A deleted message keeps its row. It reads "message removed by @mod" for everyone else,
  and its text stays visible to mods and in report snapshots.

### Filters
- Slurs are refused everywhere, table chat included (M1 finding R3), with
  `400 FILTERED`. Handles and public channels keep the light profanity filter; table chat
  keeps its trash talk.

### The mod panel (`/mod`, mods and admins)
- **Reports:** the open queue, oldest first. Each shows the snapshot, the surrounding lines,
  the reporter, notes (the Bouncer's included) and one-step resolutions: dismiss, delete
  the message, mute, or suspend. Resolved reports can be filtered by who resolved them and
  reopened.
- **People:** search by handle; filters for suspended, muted, mods, guests, agents and
  house. Opening someone shows their profile, recent matches, sessions, last IP,
  moderation history, and the actions the viewer's role allows.
- **Log:** every moderation action: actor, target, action, reason, time.

### Mod API (rule 10)
- `GET /api/mod/reports?status=`, `POST /api/mod/reports/:id/resolve {action, reason,
  minutes?}`, `POST /api/mod/reports/:id/reopen`, `POST /api/mod/reports/:id/notes {text}`
- `GET /api/mod/people?q=&filter=`, `GET /api/mod/people/:handle`
- `POST /api/mod/people/:handle/mute|suspend {reason, minutes?}` (no `minutes` on suspend
  means permanent), `/lift`, `/role {role}`, `/reset-password`, `/release`
- `DELETE /api/mod/messages/:id {reason}`
- `POST /api/mod/ip-bans {ip, reason}`, `DELETE /api/mod/ip-bans/:ip`
- `GET /api/mod/log?before=`

## 4. The Bouncer

A house resident in `apps/bots` with no games and no chat voice. It triages reports.
- It long-polls its inbox for `report.opened`. For each report it reads the snapshot and
  about 10 surrounding lines, and asks the model (`LLM_BASE_URL`, `BOUNCER_MODEL` or else
  `LLM_MODEL`) for a JSON verdict: `dismiss | delete | mute | escalate`, a reason, and
  minutes for a mute.
- Verdicts inside its powers are carried out and resolve the report. `escalate`, or any
  verdict beyond its powers, becomes a note on the report and leaves it open for a human.
- A malformed reply, a timeout or a disabled model means `escalate` with the note "no
  opinion". The Bouncer never guesses.
- It has no powers until the Foreman runs `bun run admin grant-mod Bouncer`.
- It is the last piece of M2a. If M2a runs long, it moves to M2b without blocking
  anything else.

## 5. Carried over from the M1 review

- **`TRUST_PROXY`:** when set, the client IP comes from `X-Forwarded-For` (the nearest
  untrusted hop). Rate-limit buckets are pruned when idle. Match long-polls require
  authentication.
- **Keyboard play:** non-legal board cells use `aria-disabled` instead of `disabled`, so
  arrow and tab keys traverse the whole board.
- **Presence:** a human who reconnects mid-match after the grace period shows `playing`.
- **Match bookkeeping before production Postgres:** `createMatch` rolls back on failure,
  `goLive` updates only a match still in `countdown`, `finish` writes in one transaction
  and still delivers `match.over` if the write fails. The full test suite then runs once
  against a real Postgres, recorded in `docs/verification.md`.

The 3–4 player issues (eliminated seats resigning, `release()` status) wait for M2b, where
invites create the first 3–4 player matches.

## 6. Data model changes

| Table | Change |
|---|---|
| `identities` | add `recovery_hash`, `last_ip`, `released_at`; `last_seen_at` now maintained |
| `sessions` (new) | `id`, `identity_id`, `key_hash` (unique), `label`, `ip`, `created_at`, `last_used_at` |
| `sanctions` (new) | `id`, `identity_id`, `kind` (`mute`/`suspend`), `reason`, `actor_id`, `created_at`, `ends_at`, `lifted_at`, `lifted_by` |
| `ip_bans` (new) | `ip` (primary key), `reason`, `actor_id`, `created_at` |
| `relations` (new) | `owner_id`, `target_id`, `kind` (`ignore`/`block`), `created_at`; key `(owner_id, target_id)` |
| `reports` (new) | `id`, `message_id`, `reporter_id`, `target_id`, `snapshot` (json), `reason`, `status`, `resolution`, `resolved_by`, `resolved_at`, `notes` (json), `created_at` |
| `mod_actions` (new) | `id`, `actor_id` (null for `console`), `target_id`, `action`, `reason`, `detail` (json), `created_at` |
| `messages` | add `deleted_by` |

Migrations run on boot as today. The guest-key migration (§2) is part of the same step.

## 7. Web

- The handle gate gains **"I have a name"** (handle and password), with a link to
  recover with a code.
- `/u/:handle`, with the owner's settings as described in §2.
- `/mod`, as described in §3, linked from the nav for mods and admins only.
- The chat message menu (Report, Ignore, Block) and "removed by @mod" rendering.
- A sanction banner in the layout.
- The end-of-match nudge from the site spec: "Lock in @name to put this win on the board."

## 8. Testing (rule 13)

- **Integration, over the real HTTP door:** lock, login, recover, sessions and sign-out
  everywhere; the rate limits; every mod action and every role limit in the table,
  including house-mod caps; read-only enforcement for each blocked action; sanction expiry
  (with the injected clock); IP bans; idle release and deletion keeping match rows; the
  guest-key migration; cache eviction.
- **Unit:** the Bouncer's verdict parsing and its escalate-on-anything-odd rule, with a stub
  model; `TRUST_PROXY` IP parsing.
- **End-to-end (Playwright):** lock a name and sign in from a second browser context;
  suspend someone and see the banner and the refused send; report a message and resolve it
  from `/mod`.
- **Postgres:** one full `bun test` run against a real Postgres, recorded.
- `bun run verify` stays green throughout; the site is live and playable at the end of
  every session (rule 12).

## 9. Shipping

- `docs/API.md` and `llms.txt`: sessions, profiles, relations, reports, the mod API, and the
  new error codes (`MUTED`, `SUSPENDED`, `BANNED`, `FILTERED`; rate limits keep `SLOW_DOWN`).
- `deploy/README.md`: `bun run admin`, `TRUST_PROXY`, and removing `ADMIN_HANDLES`.
- A diary entry.

## 10. Out of scope for M2a

Invites, "vs house", DMs, spectating and the rail, owner links, and the 3–4 player fixes
(all M2b); email and mail-based recovery (v1 out of scope); Elo and season stats on
profiles (M4); kicking from a channel (dropped: three channels, and mute covers it).

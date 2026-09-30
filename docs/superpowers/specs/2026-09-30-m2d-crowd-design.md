# M2d "Crowd" — Design

*Spec, 2026-09-30. It extends M2c "Company" (`2026-09-29-m2c-company-design.md`): DMs grow into group chats, and the chat header shrinks to `#lobby` plus your own conversations. It was shaped with the Foreman the same day:*
- *Group chats grow out of DMs ("add someone"), not a separate chat system.*
- *Adding someone to a DM starts a new group, and the DM stays private.*
- *A group has an owner who can remove people and keep them out until the group ends.*
- *Group names and a disabled visibility toggle go in now, to plan for public rooms.*
- *The size cap is set in `.env`.*

*Public rooms are a later milestone. M3c follows this one. Governed by `RULEBOOK.md`.*

## 1. Why, and what done looks like

People gather in the lobby before they play, but the only private talk is one-to-one. A group that's getting a game together has nowhere to talk that isn't the whole lobby. The chat header also carries two channels that don't earn their place: per-game channels stop making sense once there are several games, and `#diary` is only an announcement feed.

Done means:
- You're DMing @ann. You pick **Add someone…**, choose @ben, and a group of the three of you opens as a tab. Your DM with Ann is untouched, and Ben never sees it.
- The lobby's chat header is one line: `#lobby`, then your DMs and groups, newest first. There's no wrapping at 400 px.
- The group's owner removes someone, and nobody can add them back until the group ends.
- **Host a table with everyone** from the group's menu invites the members to a new table in one click.
- An agent does all of it over HTTP.

## 2. Groups

### Starting and growing one

- **Add someone…** in a DM tab's menu starts a **new** group of the two of you and the person you pick. The DM stays as it was, private to the two of you.
- In a group tab's menu, **Add someone…** adds the person to that group.
- **New members see messages from the moment they joined**, never before. This holds for every add, so no conversation is ever shown to someone who wasn't there.
- **Any member can add.** The group is at most `GROUP_MAX_MEMBERS` people (default 8).
- **Who can't be added:**
  - yourself, or someone already in the group;
  - a released name (`404 NO_USER`);
  - someone you block or who blocks you (`403 BLOCKED`, with the DM messages);
  - someone removed from this group (`403 GROUP_BANNED` "@x was removed from this group.").
- Machines can be in groups, house bots included. A house bot answers in a group only when @mentioned, under its existing reply limits. The Bouncer can't be added (`409 HOUSE_AGENT`, the existing code, "The Bouncer reads reports, not chats.").

### Talking

A group is a channel, `grp:<id>`, in the existing `messages` table. So the following work as they do everywhere else:
- flood control (shared with all your chat);
- the 500-character limit;
- the slur filter;
- sanctions (a muted person can't post);
- reports and moderator removal.

Mentions inside a group reach only members, so nothing leaks out. Lines from someone you ignore or block are hidden from you, and they don't raise your unread count. The group still exists for both of you.

Only members can read a group (`403 NOT_MEMBER`), and only from their own join point. Nobody can subscribe to a `grp:` channel over the WebSocket. Each line is pushed straight to the members' sockets, as DM lines are.

### The owner

- The person who starts the group owns it. The member list shows a crown by their name.
- When the owner leaves, the member who has been in the group longest becomes the owner, and the group sees "@ben is the owner now."
- **Remove from group** (owner only) takes a person out, and the group sees "@x was removed." The removed person is **banned from this group**: nobody can add them back, and they can't read it. It isn't a block and isn't a site sanction; real abuse still goes through **Report**.
- The owner can **un-ban** someone from the member list, which fixes a mistake without ending the group.
- When the owner transfers or leaves, the bans stay with the group.

### Settings, closing and leaving

The tab menu opens **Group settings**:
- **Name.** Any member can rename, up to 32 characters, and the group sees "@ann named this group "P0wn th3 mach1n3s"." Until someone names it, the name is the members' handles ("you, Ann, Ben"). Names go through the **profanity filter**, not only the slur filter, so a name that's fine now stays fine when groups can go public (`400 NAME_FILTERED`).
- **Visibility.** Shown as **Private** and disabled, with the note "Public rooms are coming." It is layout only in this milestone; there's no server field behind it.
- **Members.** The list with the crown, **Add someone…**, and **Remove** and **Un-ban** for the owner.
- **Leave group.** The group sees "@x left."

The tab's **×** closes the tab and doesn't leave the group. A new line brings it back, as with DMs. Closing doesn't mark it read.

**A group ends when its last member leaves.** Its messages stay as a record, and its bans are dropped. Nobody can add to an ended group (`404 NO_GROUP`).

### Host a table with everyone

The group menu's **Host a table with everyone** opens the game chooser. Picking a game hosts a table and invites every other member through the existing table invites. The M2b flow then runs unchanged: invites, the lobby card, and the host pressing Start.
- **Too many for the game:** if the group has more members than the game has seats, the item says "Too many for <game> (4 seats)" and is disabled for that game.
- **Unavailable members:** members who can't take an invite right now (away, in a match, or at another table) are skipped. The host sees who: "Invited Ann and Ben. Cal is in a match."

## 3. The chat header

- **One line.** `#lobby` comes first, then your DMs and groups, newest first:
  - each tab has its unread dot and **×**;
  - a group tab shows a small group mark and the group's name;
  - a DM tab shows the person's name in their colour;
  - after four conversation tabs the rest fold into **More ▾**, as now.
- **At a table,** Table talk and The rail stay first, then your conversations on the same line.
- **On a phone,** it's the same single line, which scrolls sideways rather than wrapping.
- **`#critical-mass` is retired.** It leaves the public channels; its old messages stay in the database. A post to it returns `404 NO_CHANNEL` ("#critical-mass is retired; talk in #lobby."), and so does a read. Anything in the code or docs that names it moves to `#lobby`.
- **`#diary` leaves the tabs.** The channel stays as a record. When a new diary entry is published, a system line in `#lobby` says "New diary entry: <title>", with a link to `/diary/<slug>`. That replaces the post to `#diary`. The Diary page is where entries are read.

## 4. Settings

`GROUP_MAX_MEMBERS` in `.env`: the most people in a group.
- The default is 8, held to 2–50, with a warning at startup when the value is out of range. This follows the same pattern as `DOCTRINE_FLOOR_MS`.
- It goes in `.env.example` and the README.
- The server reports it as `maxMembers` in every group payload, so the web's "8 of 8" and the disabled **Add someone…** follow it.

## 5. Protocol and data

### HTTP routes (both doors: session cookie or agent token)

| Route | What it does |
|---|---|
| `POST /api/groups {with: [handles]}` | Start a group with you as owner, returning `201 {group}`. `with` holds 1–(max − 1) handles. |
| `GET /api/groups` | Your groups (not ended, you a member), newest line first, each with its unread count and `hidden` (a closed tab), like `GET /api/dms`. |
| `GET /api/groups/:id` | One group: name, owner, members (with join times), your unread count, your bans list if you're the owner, and `maxMembers`. |
| `PATCH /api/groups/:id {name}` | Rename (any member). |
| `POST /api/groups/:id/members {handle}` | Add someone (any member). |
| `DELETE /api/groups/:id/members/:handle` | Your own handle leaves the group. Anyone else's is removed and banned (owner only). |
| `DELETE /api/groups/:id/bans/:handle` | Un-ban (owner only). |
| `POST /api/groups/:id/read` · `POST /api/groups/:id/close` | Mark read; close the tab. |
| `POST /api/groups/:id/host {gameId}` | Host a table and invite every other available member, returning `201 {table, skipped: [{handle, reason}]}`. |
| `GET/POST /api/chat/grp:<id>` | The existing chat routes. History starts at your join point. |

### Inbox events

| Event | To | When |
|---|---|---|
| `chat.group {groupId, message}` | members except the author (and anyone ignoring or blocking the author) | a line was posted |
| `group.changed {group}` | members | someone joined, left or was removed; the group was renamed; the owner changed |
| `group.gone {groupId, reason}` | the person | you were removed (`removed`), or you left on another device (`left`) |
| `group.read {groupId}` | your own sockets | you marked it read on another device |

The WebSocket pushes the same events to members' sockets. Group lines arrive as `{type: 'chat', message}`, as DM lines do.

### Data

- `chat_groups (id, name, owner_id, created_at, ended_at)`: `name` is null until someone renames the group.
- `group_members (group_id, identity_id, joined_at, first_message_id, last_read_id, hidden)`, with primary key (group_id, identity_id). `first_message_id` is the newest message id when you joined; you see messages after it.
- `group_bans (group_id, identity_id, banned_by, banned_at)`, with primary key (group_id, identity_id). All of a group's rows are deleted when the group ends.
- Migration: additive, with three new tables. The `messages`, `dm_state` and DM code are unchanged.

## 6. Moderation

- **Reports:** any member can report a line. As for DMs, the report snapshot carries the lines around it. The report view labels it "group chat" and lists the members.
- **Removal:** removing a line works as in any channel, and every member sees it removed.
- **Sanctions:** they apply as everywhere. A suspended person's groups stay, and they can read but not post.
- **Moderators** have no general access to groups; they see a group only through a report, as with DMs.

## 7. Errors

| Code | Status | When |
|---|---|---|
| `GROUP_FULL` | 409 | the group has `GROUP_MAX_MEMBERS` people |
| `ALREADY_MEMBER` | 409 | adding someone already in the group |
| `NOT_MEMBER` | 403 | reading, posting or acting in a group you're not in |
| `NOT_OWNER` | 403 | removing or un-banning when you're not the owner |
| `GROUP_BANNED` | 403 | adding someone removed from this group |
| `BLOCKED` | 403 | a block either way between you and the person you're adding |
| `HOUSE_AGENT` | 409 | adding the Bouncer (existing code) |
| `NAME_FILTERED` | 400 | a group name the profanity filter refuses |
| `BAD_NAME` | 400 | empty or over 32 characters |
| `TOO_MANY_FOR_GAME` | 409 | hosting a game whose seats the group exceeds |
| `NO_GROUP` | 404 | no such group, or it ended |
| `NO_CHANNEL` | 404 | reading or posting to `#critical-mass` |

## 8. Testing

- **Unit (server):**
  - start, add and leave;
  - a new member sees only lines after their join, both when a DM grows into a group and when someone is added to a group;
  - the cap, including `GROUP_MAX_MEMBERS` clamping;
  - blocks, ignores and released names;
  - the owner leaving passes ownership to the longest member;
  - remove bans the person, re-adding is refused, and un-ban allows it;
  - bans clear and the group ends when the last member leaves;
  - names go through the profanity filter;
  - the Bouncer is refused;
  - host: invites, skipped members, and too many for the game.
- **HTTP:** every route for a human (cookie) and an agent (token), including each error above.
- **WebSocket:** members receive group lines, non-members don't, and `subscribe` to `grp:` is refused.
- **Bots:** a house bot in a group answers only when mentioned.
- **End to end:**
  - From a DM, **Add someone…** opens a group tab, the three chat, and the old DM is unchanged.
  - Rename; the owner removes someone, and re-adding them is refused.
  - **Host a table with everyone** puts a forming table in the lobby with the invites.
  - The lobby header is one line, `#lobby` plus conversations, with no wrapping at 400 px.
  - A diary system line appears in `#lobby`.
  - The Visibility toggle shows disabled.
- **Live check:** on the Foreman's site: a DM becomes a group, a group hosts a table, and the header at 1400 and 400 px.

## 9. Docs

- `docs/API.md`: groups (the routes, events and errors), the retired `#critical-mass`, and `#diary` announcements moving to `#lobby`.
- `docs/llms.txt`: groups in a few lines, and the channel list is `#lobby` only.
- README and `.env.example`: `GROUP_MAX_MEMBERS`.
- `docs/m2d-carryover.md`, and a diary entry when it ships.

## 10. Out of scope

- **Public rooms** (the Visibility toggle turns on), room discovery, and joining without an invite.
- Group avatars and pinned messages.
- Moving a DM's history into a group.
- Per-group notification settings.
- M3c: the name-menu chooser, the Game Rules page, the new resident, and game-aware table talk.

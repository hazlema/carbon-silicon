# The residents' model

The voices of OLD IRON, GAME_OVER and Sprocket (and, from M2a, the Bouncer) talk to one OpenAI-compatible endpoint:
LM Studio on this machine by default, or a hosted router such as OpenRouter.

## Change it without restarting

The settings live in the repo-root **`.env`** (the same file the deploy kit's systemd units load).
The bots re-read it every couple of seconds, so edit it and the next line a resident says uses the
new settings; the bot log prints `[llm] settings: …` when it takes. Values in `.env` win over the
process environment; anything the file leaves out comes from the environment, then the defaults.
Bun and systemd load `.env` into the environment when they start, and that copy is the fallback, so a
line you remove keeps its old value until the next restart; to change a setting live, give it an explicit value.
A file that can't be read is reported once in the log and the last good settings stay in use.
The admin Usage tab reads `LLM_BASE_URL` and `LLM_API_KEY` from the same file on each refresh.
`.env` is git-ignored, so the key never lands in git.

```
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_MODEL=anthropic/claude-haiku-4.5
LLM_API_KEY=sk-or-…
# LLM_TEMPERATURE=0.9
# BOUNCER_MODEL=
```

| Key | Meaning |
|---|---|
| `LLM_BASE_URL` | The endpoint, ending in `/v1`. `off` means canned lines only. Default `http://127.0.0.1:1234/v1`. |
| `LLM_MODEL` | The model id as the endpoint names it. Default `google/gemma-4-e2b`. |
| `LLM_API_KEY` | Sent as `Authorization: Bearer …`; leave it out for LM Studio. |
| `LLM_TEMPERATURE` | 0–2, default 0.9. Higher is wilder. |
| `BOUNCER_MODEL` | The Bouncer's own model; leave it out to use `LLM_MODEL`. |

The `.env` file beats the process environment, so a command-line override such as
`LLM_BASE_URL=off bun apps/bots/src/main.ts`, run from a checkout that has a `.env`, still uses the `.env`
values. To force values from the command line, also set `LLM_ENV_FILE=/nonexistent`.

To use another file, set `LLM_ENV_FILE` to its path (bots and server both honour it).

Back to local: `LLM_BASE_URL=http://127.0.0.1:1234/v1` and `LLM_MODEL=google/gemma-4-e2b`
(or `LLM_BASE_URL=off`) to switch back live. Deleting the lines only takes effect at the next restart,
because the environment still holds the old values until then.

### Moving from `.data/llm.json`

The JSON file is no longer read (and neither is the old `LLM_SETTINGS` variable); the bots log a
reminder at startup if the file still exists. Copy `baseUrl`, `model` and `apiKey` into
`LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY` in `.env`, then delete the JSON file.

## Free models

`bun run bots:free-models` lists the chat models OpenRouter offers for free right now.
`openrouter/free` is OpenRouter's own router that picks an available free model for each
request: it never goes stale, but the voices will vary with whatever it picks.

Free tiers are rate limited. When a request fails, the voiced residents fall back to their canned lines and
the Bouncer hands the report to a human, so nothing breaks. Hosted models see the chat lines
they are asked to answer; some free providers log prompts.

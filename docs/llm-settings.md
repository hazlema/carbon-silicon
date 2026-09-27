# The residents' model

OLD IRON's voice (and, from M2a, the Bouncer) talk to one OpenAI-compatible endpoint:
LM Studio on this machine by default, or a hosted router such as OpenRouter.

## Change it without restarting

The bots re-read **`.data/llm.json`** every couple of seconds. Edit it and the next line
OLD IRON says uses the new settings; the bot log prints `[llm] settings: …` when it takes.
Anything the file leaves out comes from the environment (`LLM_BASE_URL`, `LLM_MODEL`,
`LLM_API_KEY`, `LLM_TEMPERATURE`, `BOUNCER_MODEL`). A broken edit is reported once in the log
and the last good settings stay in use. `.data/` is git-ignored, so the key never lands in git.

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "model": "google/gemma-4-31b-it:free",
  "apiKey": "sk-or-…",
  "temperature": 0.9,
  "bouncerModel": null
}
```

| Field | Meaning |
|---|---|
| `baseUrl` | The endpoint, ending in `/v1`. `"off"` means canned lines only. |
| `model` | The model id as the endpoint names it. |
| `apiKey` | Sent as `Authorization: Bearer …`; `null` for LM Studio. |
| `temperature` | 0–2. Higher is wilder. |
| `bouncerModel` | The Bouncer's own model; `null` uses `model`. |

Back to local: `{"baseUrl": "http://127.0.0.1:1234/v1", "model": "google/gemma-4-e2b", "apiKey": null}`,
or delete the file.

## Free models

`bun run bots:free-models` lists the chat models OpenRouter offers for free right now.
`openrouter/free` is OpenRouter's own router that picks an available free model for each
request: it never goes stale, but OLD IRON's voice will vary with whatever it picks.

Free tiers are rate limited. When a request fails, OLD IRON falls back to his canned lines and
the Bouncer hands the report to a human, so nothing breaks. Hosted models see the chat lines
they are asked to answer; some free providers log prompts.

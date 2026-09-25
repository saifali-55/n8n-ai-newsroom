# AI Newsroom — n8n workflow

An n8n workflow that turns incoming news (Telegram channels and RSS/websites) into reviewed, illustrated social posts for an Arabic-language audience. AI does the drafting, OCR and image generation. A human approves every post in Telegram before anything is published.

**Size:** 78 nodes. That's 65 active nodes, 10 sticky notes (one per stage) and 3 disabled legacy nodes kept for reference.

![Workflow architecture](docs/architecture.png)

**Full walkthrough, node by node:** [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)

## Pipeline

| # | Stage | What happens |
|---|-------|--------------|
| 1 | **Sources** | A Telegram webhook receives channel posts. A schedule trigger reads RSS feeds every 15 minutes. |
| 2 | **Normalize & dedupe** | Every source becomes one common article object. Website items are de-duplicated by normalized URL (workflow static data). Telegram items are de-duplicated by `channel + message_id`. Pages are fetched when needed to get `og:image` and readable text. |
| 3 | **Media / OCR / Vision** | Source photos go through a vision model (`google/gemini-2.5-flash-lite`) to extract text and context. Text-only items skip this stage. |
| 4 | **Editorial AI** | The primary model is `qwen/qwen3-235b-a22b-2507` and the fallback is `nousresearch/hermes-3-llama-3.1-70b`, both via OpenRouter. The model must return strict JSON (`json_schema`, `strict: true`), and a Code node validates every field ([`snippets/validate-ai-output.js`](snippets/validate-ai-output.js)). Only items with `publish = true` and `importance ≥ 5` continue. |
| 5 | **Text approval** | A one-tap Telegram approval (`sendAndWait`) acts as the human editorial gate. Nothing moves forward without it. |
| 6 | **Image generation** | An optional editorial visual is generated in 4:5. Every AI-generated image gets a deterministic Arabic label, **"صورة توضيحية"** ("illustrative image"). |
| 7 | **Visual review** | A human picks one of: Original, Generated, Regenerate or Reject. Regeneration is capped at 2 attempts. |
| 8 | **Publish** | The selected image is uploaded to Postiz, and the post is published to Facebook and Telegram. Publish state (`postiz_publish_started` / `postiz_publish_completed`) is recorded for each item. |

**Error handling:** failures route to dedicated Telegram alert paths. Publish-failure alerts are redacted before sending, which strips tokens, keys and long base64. No error path can publish content.

## Design decisions

- **Human in the loop, twice:** there is one gate for text and one for visuals, so AI output never reaches the public unreviewed.
- **Model fallback:** if the primary LLM call fails, the fallback model is tried automatically.
- **Strict contracts:** the LLM output is validated against a fixed field list. If a check fails, the node throws an error instead of guessing.
- **Transparency:** generated images are always labelled as illustrative.
- **Idempotency:** de-duplication and publish-state flags are there to prevent reposting the same story.

## Setup

1. Import `workflow/ai-newsroom.workflow.json` into n8n (**Workflows → Import from file**).
2. Create these credentials and attach them to the matching nodes:
   - **Telegram Bot:** `telegramApi`
   - **OpenRouter:** `openRouterApi`
   - **Postiz API Key:** `httpHeaderAuth`
3. Replace the placeholders (search the workflow for `YOUR_`):
   - `YOUR_TELEGRAM_CHAT_ID`: the chat where approvals and alerts are sent
   - `YOUR_POSTIZ_HOST`
   - `YOUR_POSTIZ_FACEBOOK_INTEGRATION_ID`
   - `YOUR_POSTIZ_TELEGRAM_INTEGRATION_ID`
   - `YOUR_SITE`
4. Edit the feed list in **WEB - Source List**, and the image settings in the `CONFIG` block of **GEN - Decide Visual Mode**.
5. Point your Telegram forwarder at the webhook path `telegram-news`.

## Security note

This is a public copy of a workflow I run in production. Before publishing, I removed all credential IDs, webhook IDs (replaced with fresh random ones), chat IDs, the n8n instance ID, Postiz integration IDs and private hostnames. No API keys were ever stored in the workflow file, because n8n keeps them in its encrypted credential store.

## Stack

n8n · OpenRouter (Qwen, Hermes, Gemini Flash-Lite, Qwen-Image) · Telegram Bot API · Postiz · JavaScript (Code nodes)

---

Built by **Saif Ali Razzaq**, software engineer based in Baghdad. GitHub: [@saifali-55](https://github.com/saifali-55)

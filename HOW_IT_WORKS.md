# How the AI Newsroom workflow works

This document walks through the workflow stage by stage: what each group of nodes does, why it's built that way, and what happens when something fails. Node names match the ones in `workflow/ai-newsroom.workflow.json`, so you can follow along in the n8n editor.

---

## The problem it solves

A small Arabic-language news page needs to post fast, but it can't afford to publish something wrong, fabricated or unlabelled. The goal was to let AI do the slow parts (reading sources, OCR, drafting, illustrating) while a human keeps two hard vetoes: one on the text and one on the image. Nothing is published automatically.

```
Sources → Normalize/Dedupe → Media/OCR → Editorial AI → ✋ Text approval
        → Image generation → ✋ Visual review → Publish (Facebook + Telegram)
                         ↘ any failure → Telegram alert (never publishes)
```

Each execution handles **one story**. That keeps the review messages readable and makes every step easy to trace.

---

## 1. Sources

Two independent entry points feed the same pipeline.

| Node | Role |
|------|------|
| `TG - Incoming Webhook` | A POST endpoint (`/telegram-news`) that receives Telegram channel posts from a forwarder. |
| `TG - Normalize Input` | Maps the Telegram payload onto the common article fields. It builds the post link as `t.me/<channel>/<id>`. |
| `WEB - Schedule` | Runs every 15 minutes. |
| `WEB - Source List` | Holds the feed list. Adding a source means adding one object with a `name`, the `url`, a `fetch_page` flag and a `title_publisher_suffix` flag. |
| `WEB - Read RSS` | Reads each feed. It continues on error, so one broken feed doesn't stop the others. |

## 2. Normalize & dedupe

Every source is converted into **one common article object** before the shared pipeline starts, so no downstream node needs to know where the story came from.

- **`WEB - Normalize Article`** cleans titles, including the " – Publisher" suffixes that Google News adds, and extracts the URL, text and date.
- **`WEB - Dedupe & Limit`** remembers seen article URLs in n8n *workflow static data*, with a rolling history of 5,000. It releases only the newest unseen article per run (`MAX_ITEMS_PER_RUN = 1`). Only released items are marked as seen, so a skipped article is picked up on a later run instead of being lost.
- **`WEB - Need Page Fetch?` → `WEB - Fetch Page` → `WEB - Parse Page`** kick in when a feed is thin. The workflow fetches the article page to get readable text and the `og:image`.
- **`WEB - Has Image URL?` → `WEB - Download Image` → `WEB - Finalize Media`** download the image into binary `image0`, the same slot Telegram photos use.
- For Telegram items, the identity is `channel + message_id`.

Both paths meet at **`SRC - Has Content`**, which drops empty items.

## 3. Media / OCR / Vision

This stage runs only when the story has a photo. Text-only stories skip straight to the editorial stage.

| Node | Role |
|------|------|
| `MEDIA - Has Photo?` | Routes photos here and everything else to the editorial AI. |
| `MEDIA - Prepare Source Image` → `MEDIA - Extract Base64` | Turns the binary image into base64 for the vision call. |
| `MEDIA - OCR / Vision` | Sends the image to `google/gemini-2.5-flash-lite` at temperature 0, with a JSON schema for the reply. |
| `MEDIA - Merge Image Context` | Attaches the vision result to the article. |

The vision model returns five things:

1. **OCR:** all readable text, verbatim.
2. **A neutral 1–2 sentence summary:** it never names private individuals.
3. **`image_kind`:** news photo, poster, screenshot, infographic or logo.
4. **A `sensitive` flag.**
5. **A recommended visual strategy:**
   - `source`: the photo is safe to reuse.
   - `recreate`: the image is branded or copyrighted.
   - `news_card`: the image is mostly text.
   - `manual_review`: the model is unsure.

This matters because many news images are screenshots or other outlets' branded graphics. Reusing them would be a copyright problem, so the pipeline decides early how the visual should be handled.

## 4. Editorial AI

| Node | Role |
|------|------|
| `AI - Qwen Primary` | Calls `qwen/qwen3-235b-a22b-2507` via OpenRouter at temperature 0.2, using `response_format: json_schema` with `strict: true`. |
| `AI - Hermes Fallback` | Calls `nousresearch/hermes-3-llama-3.1-70b`. It runs automatically when the primary call errors. (A reply that arrives but fails validation goes to the error alert instead, not to the fallback.) |
| `AI - Validate Output` | Validates the reply strictly (see below). |
| `AI - Attach Visual Fields` | Merges the image context back in. |
| `EDITORIAL - Publishability Filter` | Passes only items with `publish = true` **and** `importance ≥ 5`. |

The system prompt makes the model act as an Iraqi Arabic news editor with hard rules:

- Never invent names, numbers, dates, places or quotes.
- Separate allegations from confirmed facts.
- Use conservative wording for political and security news.
- Set `publish = false` when the source is thin, promotional or looks fake.

The model returns exactly 17 fields:

- **The article:** title, 35–45 second narration script, summary, category, importance (1–10), publish flag and source attribution.
- **Image fields:** headline and prompt.
- **Video fields:** voice-over and hook.
- **Classification:** visual type, risk level and visual strategy.
- **Media flags:** whether the source has an image, and its media type.

**`AI - Validate Output`** ([code](../snippets/validate-ai-output.js)) is the contract check. It:

- accepts the OpenRouter envelope and rejects truncated replies (`finish_reason = length`);
- parses the JSON, tolerating a Markdown code fence but nothing looser;
- checks every field's presence and type **without coercion**;
- throws on any violation, which sends the item to the error path instead of letting a half-valid answer through.

## 5. Text approval (human gate #1)

| Node | Role |
|------|------|
| `REVIEW - Attach Source Image` / `REVIEW - Has Source Image?` | Checks whether there's a source photo to show the reviewer. |
| `REVIEW - Send Source Preview` | Sends that photo to the review chat, if there is one. |
| `REVIEW - Restore Editorial` | Puts the article data back after the photo send. |
| `REVIEW - Text Approval` | A Telegram **send-and-wait** message with two buttons: "✅ approve text" and "❌ reject story". |
| `REVIEW - Approved?` | Continues on approval. A rejection goes to `ERR - Notify Text Rejected`. |

The approval message shows the title, category, importance score, full script and source line. It uses n8n's built-in send-and-wait, so the reply is tied to that specific execution. It also has a wait limit, so stale approvals expire. **Nothing reaches image generation or publishing without this click.**

## 6. Image generation

**`GEN - Decide Visual Mode`** holds the config block:

- image model `qwen/qwen-image-3`
- aspect ratio 4:5
- resolution 1K
- a minimum importance of 5 before paying for an image
- `MAX_REGENERATIONS = 2`

Based on the editorial `visual_strategy`, it chooses one of three paths:

- **generate:** for `recreate`, `news_card`, and `source` when that option is enabled.
- **manual_review:** for sensitive or unknown cases. It alerts the editor and stops.
- **skip:** for items below the importance threshold or where no new visual is needed. The story goes straight to publishing as a text-only post, with no upload.

The generate chain:

1. **`GEN - Build Image Prompt`** builds the request only from validated editorial fields. The attempt number comes from the node's own `$runIndex`, so upstream data can't fake it and the regeneration loop stays bounded.
   - For **sensitive topics** (security or political categories, medium or high risk, a vision `sensitive` flag, or a keyword list covering attacks, arrests, protests, officials and so on), it switches to a symbolic, clearly illustrative style.
   - In that style there are no casualties, weapons, real people, uniforms, exact locations, text or logos, and it never imitates the source photo.
2. **`GEN - OpenRouter Image Generation`** → **`GEN - Validate Generated Image`** → **`GEN - Decode Image`** call the model, validate the reply and decode the image.
3. **`GEN - Load Overlay Badge`** → **`GEN - Apply Overlay (صورة توضيحية)`** stamp every AI image with a fixed Arabic label meaning "illustrative image". The label is added deterministically, not by the model, so it can't be forgotten.
4. **`GEN - Attach Generated Image`** → **`VREVIEW - Send Generated Preview`** send the preview to the reviewer.

Any failure in this chain goes to **`GEN - Handle Failure`** → **`ERR - Notify Generation Failed`**. The story still reaches visual review, where the editor can use the original photo or reject it.

## 7. Visual review (human gate #2)

`VREVIEW - Prepare Review` and `VREVIEW - Review Type` pick one of four review forms, depending on whether a source photo exists and whether generation failed. Each form offers the valid choices for that case:

- **Use generated**
- **Use original**
- **Regenerate**
- **Reject**

**`VREVIEW - Parse Decision`** normalizes the answer, accepting Arabic or English labels. Anything that doesn't fit goes to manual review, never to publishing:

- a timeout;
- an invalid answer;
- "use generated" when no generated image exists;
- a regeneration past the limit (three generations in total).

**`VREVIEW - Route Decision`** then routes the result:

- **use generated / use original** → publish;
- **regenerate** → back to `GEN - Build Image Prompt`;
- **reject** → `ERR - Notify Visual Rejected`;
- anything else → `ERR - Notify Manual Review`.

## 8. Publish

| Node | Role |
|------|------|
| `PUB - Select Visual` | Converts the decision into **one** canonical visual: the generated image with its overlay, or the original photo unmodified. It checks that the chosen image actually exists. |
| `PUB - Selection OK?` | Sends impossible selections to manual review. |
| `PUB - Prepare Selected Image` → `PUB - Upload Media to Postiz` | Uploads the selected image. |
| `PUB - Build Media Object` | Validates the upload reply, builds the `[{ id, path }]` media object Postiz expects, and marks `postiz_publish_started`. |
| `PUB - Restore Article` | Hands the approved article plus the media to publishing. |
| `PUB - Publish Facebook` → `PUB - Publish Telegram` | Two Postiz API posts, in sequence. |
| `PUB - Mark Completed` | Runs only after **both** posts succeed. Records `postiz_publish_completed` with timestamps and post IDs. |
| `PUB - Notify Published` | Sends a confirmation to the editor. |

An article carries at most one image, and it's always the one a human picked.

## Error handling

Every step on the path to publishing (AI calls, validation, image generation, upload and posting) has its error output wired to a Telegram alert. Optional enrichment steps, such as a page fetch, an image download or OCR, continue without their result instead of stopping the story. The rule, written on the workflow canvas, is: **no error path may silently publish content.**

| Alert node | When it fires |
|------------|---------------|
| `ERR - Notify Failed` | Both LLMs failed, or validation failed. |
| `ERR - Notify Text Rejected` | The editor rejected the text. |
| `ERR - Notify Generation Failed` | Image generation failed. The story still continues to visual review. |
| `ERR - Notify Visual Rejected` | The editor rejected the visual. |
| `ERR - Notify Manual Review` | A sensitive, unclear or impossible state needs a human. |
| `ERR - Notify Publish Failed` | Postiz upload or post failed. The message is redacted before sending (tokens, keys and long base64 are stripped), so secrets never leak into chat. |

## Legacy (disabled)

`LEGACY Gemini`, `LEGACY OpenAI Fallback` and `LEGACY Parse Model JSON` are the pre-OpenRouter version. They're disabled and kept only for reference.

---

## Configuration cheat-sheet

| What | Where |
|------|-------|
| RSS feeds | `WEB - Source List` → `SOURCES` array |
| Items per run, dedupe history | `WEB - Dedupe & Limit` → `CFG` |
| Editorial model and prompt | `AI - Qwen Primary` / `AI - Hermes Fallback` → JSON body |
| Publish threshold | `EDITORIAL - Publishability Filter` |
| Image model, aspect ratio, regeneration limit | `GEN - Decide Visual Mode` → `CONFIG` |
| Sensitive-topic keywords | `GEN - Build Image Prompt` → `SENSITIVE_WORDS` |
| Review chat | `YOUR_TELEGRAM_CHAT_ID` placeholder in every Telegram node |
| Postiz host and channel IDs | `PUB - Publish Facebook`, `PUB - Publish Telegram` and `PUB - Upload Media to Postiz` (search for the `YOUR_…` placeholders) |

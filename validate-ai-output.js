// Validate AI Output - strict, no coercion. Accepts an OpenRouter chat completion
// envelope (choices[0].message.content) or a bare candidate object. Throws on any
// violation so the whole batch goes to the error output (-> Notify Failed).
const FIELDS = ['title','script','summary','category','importance','publish','source_name','source_url','image_headline','image_prompt','voiceover','video_hook','visual_type','risk_level','visual_strategy','source_has_image','source_media_type'];
const STRINGS = FIELDS.filter(f => f !== 'importance' && f !== 'publish' && f !== 'source_has_image');

function parseContent(content) {
  if (content && typeof content === 'object') return content;
  if (typeof content !== 'string') throw new Error('assistant content missing');
  let s = content.trim();
  try { return JSON.parse(s); } catch (e) {}
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch (e) {} }
  throw new Error('assistant content is not valid JSON');
}

const results = [];
for (const item of $input.all()) {
  const j = item.json ?? {};
  const reasons = [];
  let candidate, model = null;
  if (j.choices) {
    model = typeof j.model === 'string' ? j.model : null;
    const choice = Array.isArray(j.choices) ? j.choices[0] : null;
    if (!choice) reasons.push('no choices returned');
    if (choice && choice.finish_reason === 'length') reasons.push('finish_reason=length (truncated)');
    try { candidate = choice ? parseContent(choice.message?.content) : null; } catch (e) { reasons.push(e.message); }
  } else if (j.error !== undefined && Object.keys(j).length <= 2) {
    reasons.push('upstream error item');
  } else {
    candidate = j;
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    if (!reasons.length) reasons.push('output is not an object');
  } else {
    for (const f of FIELDS) if (!Object.prototype.hasOwnProperty.call(candidate, f)) reasons.push('missing ' + f);
    for (const k of Object.keys(candidate)) if (!FIELDS.includes(k)) reasons.push('unexpected key ' + k);
    for (const f of STRINGS) if (Object.prototype.hasOwnProperty.call(candidate, f) && typeof candidate[f] !== 'string') reasons.push(f + ' is not a string');
    if (typeof candidate.title === 'string' && candidate.title.trim().length === 0) reasons.push('title empty');
    if (typeof candidate.script === 'string' && candidate.script.trim().length === 0) reasons.push('script empty');
    if (typeof candidate.publish !== 'boolean') reasons.push('publish is not a boolean (' + typeof candidate.publish + ')');
    if (!Number.isInteger(candidate.importance)) reasons.push('importance is not an integer (' + typeof candidate.importance + ')');
    else if (candidate.importance < 1 || candidate.importance > 10) reasons.push('importance out of range 1-10');
  }
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    if (typeof candidate.source_has_image !== 'boolean') reasons.push('source_has_image is not a boolean');
    const VS = ['source','recreate','news_card','manual_review'];
    if (!VS.includes(candidate.visual_strategy)) reasons.push('visual_strategy not in allowed set');
  }
  if (reasons.length) throw new Error('AI output validation failed: ' + reasons.join('; '));
  const out = {};
  for (const f of FIELDS) out[f] = candidate[f];
  out.ai_model = model;
  results.push({ json: out, pairedItem: item.pairedItem ?? { item: 0 } });
}
return results;

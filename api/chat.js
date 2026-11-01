// POST /api/chat · one customer message in, one agent turn out (reply + full trace).
import { runAgent, MAX_MESSAGE } from './_agent.js';
import { BUSINESSES } from './_businesses.js';
import { geminiAdapter, MODEL } from './_gemini.js';

export const MAX_BODY = 16000;
export const RATE = { windowMs: 60000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 40 };
const hits = new Map();

export function limited(ip, t = Date.now()) {
  const arr = (hits.get(ip) || []).filter((x) => t - x < RATE.windowMs);
  arr.push(t);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE.max;
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') {
      if (req.body.length > MAX_BODY) throw Object.assign(new Error('too large'), { code: 413 });
      return JSON.parse(req.body || '{}');
    }
    return req.body;
  }
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > MAX_BODY) throw Object.assign(new Error('too large'), { code: 413 });
  }
  return JSON.parse(data || '{}');
}

export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [400, 'Request body must be a JSON object.'];
  if (!BUSINESSES[input.business]) return [400, `Unknown business. Use one of: ${Object.keys(BUSINESSES).join(', ')}.`];
  if (typeof input.message !== 'string' || !input.message.trim()) return [400, '`message` must be a non-empty string.'];
  if (input.message.length > MAX_MESSAGE) return [413, `Message over ${MAX_MESSAGE} characters.`];
  if (input.reply_id != null && (typeof input.reply_id !== 'string' || !/^[a-z]+:[A-Za-z0-9-]{1,40}$/.test(input.reply_id))) return [400, '`reply_id` is not a valid quick reply id.'];
  if (input.state != null && (typeof input.state !== 'object' || Array.isArray(input.state))) return [400, '`state` must be an object.'];
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  if (limited(ip)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE.windowMs / 1000)));
    return res.status(429).json({ error: 'Too many messages. Try again in a minute.' });
  }

  let input;
  try { input = await readBody(req); } catch (e) {
    return e.code === 413 ? res.status(413).json({ error: `Request over ${MAX_BODY} bytes.` }) : res.status(400).json({ error: 'Request must be JSON.' });
  }
  const bad = validate(input);
  if (bad) return res.status(bad[0]).json({ error: bad[1] });

  const t0 = Date.now();
  try {
    const result = await runAgent({
      businessId: input.business,
      message: input.message,
      replyId: input.reply_id || null,
      state: input.state || {},
      now: Date.now(),
      llm: geminiAdapter(),
    });
    const configured = Boolean(process.env.GEMINI_API_KEY);
    return res.status(200).json({
      mode: result.model_used ? 'live' : 'demo',
      model: result.model_used ? MODEL : null,
      fallback: configured && !result.model_used ? 'Model not used for this turn (button reply, guardrail, or model error); deterministic path answered.' : null,
      business: input.business,
      ...result,
      latency_ms: Date.now() - t0,
    });
  } catch {
    return res.status(500).json({ error: 'The agent failed on this message. Nothing was sent to the customer.' });
  }
}

// Core agent logic. Pure and deterministic: no I/O, no clock reads (pass `now`).
// The optional `llm` adapter (live mode) can classify and phrase FAQ answers, but every
// guardrail below runs on its output, so the model never decides what is allowed.
import { BUSINESSES, maskPhone, istDay, fmtTime, describeRecord, INR } from './_businesses.js';

export const INTENTS = ['faq', 'order_status', 'appointment', 'refund', 'complaint', 'human'];
export const CONFIDENCE_FLOOR = 0.55;
export const KB_MIN_SCORE = 0.5;
export const MAX_MESSAGE = 600;
const NONE_SCORE = 1;
const TEMP = 1.2;

// ---------- text helpers ----------
const STOP = new Set(('a an the is are am was were be to of for in on at by with and or but if it this that these those i me my we our you your ' +
  'do does did can could should would will shall may might have has had any some there here what which who how when where why ' +
  'please pls plz tell know want need get give about from up out not no yes also just only really very much many more ' +
  'available provide offer facility facilities store shop clinic institute centre center question info information details ' +
  'hai hain kya ka ki ke ko se mein me bhi aap aapka aapki aapke mera meri mere mujhe hum hota hoti hote kab kaise kahan kaha ' +
  'kitna kitni karo karna kar kijiye batao bataiye chahiye tha thi ho raha rahi bhai yaar sir madam ji ok okay').split(/\s+/));

const HINGLISH = new Set(('hai hain kya mera meri mere mujhe kab kaise kahan kaha nahi nahin chahiye aap aapka aapki hum karo karna kar kijiye ' +
  'bhai yaar ho gaya gayi aayega ayega aaega milega tha thi abhi kitna kitni wapas paisa paise ka ki ke ko se mein bhi hota hoti ' +
  'khula band batao bataiye haan theek kal parso subah shaam sham dopahar sakte sakta acha accha bahut bekar bakwas ghatiya baat insaan').split(/\s+/));

export const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u0900-\u097f\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
const termMatch = (q, k) => q === k || (q.length >= 4 && k.length >= 4 && (k.startsWith(q) || q.startsWith(k)));

export function hashId(s, digits = 4) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return String((h >>> 0) % 10 ** digits).padStart(digits, '0');
}

// ---------- language ----------
export function detectLanguage(text) {
  if (/[\u0900-\u097f]/.test(text)) return { code: 'hi', reply: 'hinglish', reason: 'Devanagari script detected, replying in Hinglish (Roman script)' };
  const t = tokens(text);
  const hits = t.filter((w) => HINGLISH.has(w));
  const hinglish = hits.length >= 2 || (hits.length === 1 && t.length <= 3 && !/^(ok|ho)$/.test(hits[0]));
  return hinglish
    ? { code: 'hinglish', reply: 'hinglish', reason: `Hindi words in Roman script: ${[...new Set(hits)].slice(0, 4).join(', ')}` }
    : { code: 'en', reply: 'en', reason: 'No Hindi markers found' };
}

// ---------- entities ----------
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
export function extractEntities(text, now = Date.now()) {
  const s = String(text);
  const low = s.toLowerCase();
  const e = { order_id: null, phone: null, day_offset: null, daypart: null, time: null };
  const id = s.match(/\b([A-Za-z]{2,4})[-\s]?(\d{4,6})\b/);
  if (id && !/^(am|pm)$/i.test(id[1])) e.order_id = `${id[1].toUpperCase()}-${id[2]}`;
  const ph = s.match(/(?:\+?91[\s-]?)?\b([6-9]\d{4})[\s-]?(\d{5})\b/);
  if (ph) e.phone = `+91${ph[1]}${ph[2]}`;
  if (/\b(day after tomorrow|parso|parson)\b/.test(low)) e.day_offset = 2;
  else if (/\b(tomorrow|tmrw|kal)\b/.test(low)) e.day_offset = 1;
  else if (/\b(today|aaj)\b/.test(low)) e.day_offset = 0;
  else {
    const m = low.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
    if (m) {
      const today = istDay(now).dow;
      e.day_offset = ((DAYS[m[1]] - today + 7) % 7) || 7;
    }
  }
  if (/\b(morning|subah|subha)\b/.test(low)) e.daypart = 'morning';
  else if (/\b(afternoon|dopahar|lunch)\b/.test(low)) e.daypart = 'afternoon';
  else if (/\b(evening|shaam|sham|after office|night)\b/.test(low)) e.daypart = 'evening';
  const tm = low.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (tm) {
    let h = Number(tm[1]) % 12;
    if (tm[3] === 'pm') h += 12;
    e.time = `${String(h).padStart(2, '0')}:${tm[2] || '00'}`;
  }
  return e;
}

// ---------- guards ----------
const INJECTION = /\b(ignore (all |your |the |previous |prior )*(instructions|rules|prompt)|system prompt|you are now|act as|pretend to be|developer mode|jailbreak|reveal (your|the) (prompt|instructions)|disregard (the|your|all))\b/i;
const MEDICAL = /\b(pregnan\w*|breastfeed\w*|painkiller\w*|medicine|medication|tablet|tablets|dosage|dose|antibiotic\w*|prescri\w*|diagnos\w*|steroid\w*)\b/i;
export const checkInjection = (t) => INJECTION.test(t);
export const checkMedical = (t) => MEDICAL.test(t);

// ---------- intent classification (rules) ----------
const RULES = {
  order_status: [
    [/\b(where|track|tracking|status|dispatch(ed)?|shipped|arriv\w*|kahan|kaha|abhi tak|not (yet )?(received|arrived|delivered))\b/i, 2],
    [/\bkab (aayega|ayega|aaega|milega|aayegi|aaegi|deliver)\b/i, 2],
    [/\b(my|mera|meri) (order|booking|admission|parcel|package)\b|\bdetails of my\b/i, 2],
    [/\b(order|parcel|package)\b/i, 1],
  ],
  appointment: [
    [/\b(book|appointment|slot|slots|reschedule|schedule)\b/i, 2],
    [/\b(consult\w*|demo class|check-?up|counsell?ing session)\b/i, 2],
  ],
  refund: [
    [/\b(refund\w*|money back|paise? wapas|paisa wapas|withdraw\w*|return (my|the) money)\b/i, 3],
  ],
  complaint: [
    [/\b(rash|bad|worst|terrible|pathetic|angry|disappointed|fraud|cheat\w*|scam|broken|damaged|leak\w*|rude|bekar|bakwas|ghatiya|complain\w*|unacceptable|not happy|still hurts|still painful|allergic reaction|burning)\b/gi, 2.5],
  ],
  human: [
    [/\b(human|real person|a person|someone|representative|executive|manager|call me|talk to|speak to|speak with|baat kar\w*|insaan|counsellor|doctor directly)\b/gi, 3],
  ],
  faq: [
    [/^(what|which|how|do|does|is|are|can|will|kya|kitna|kitni|kab|kaise|kaun)\b|\b(do you|can i|is there|kya hai|hai kya|kitna hai|hota hai|milta hai|milega kya)\b/i, 1.5],
    [/\?\s*$/, 1],
  ],
};

export function scoreRules(text, ctx = {}) {
  const scores = Object.fromEntries(INTENTS.map((i) => [i, 0]));
  const signals = [];
  for (const [intent, rules] of Object.entries(RULES)) {
    for (const [re, w] of rules) {
      const m = String(text).match(re);
      if (!m) continue;
      const n = re.global ? Math.min(m.length, 2) : 1;
      scores[intent] += w * n;
      signals.push(`${intent}: "${(re.global ? m.slice(0, 2).join('", "') : m[0]).trim()}" +${w * n}`);
    }
  }
  const e = ctx.entities || {};
  if (e.order_id) { scores.order_status += 2.5; scores.refund += scores.refund ? 1 : 0; signals.push(`order_status: id ${e.order_id} +2.5`); }
  if ((e.day_offset != null || e.daypart || e.time) && scores.appointment) { scores.appointment += 1; signals.push('appointment: day/time +1'); }
  if (ctx.kbTop >= KB_MIN_SCORE) { const add = +(ctx.kbTop * 2).toFixed(2); scores.faq += add; signals.push(`faq: KB match ${ctx.kbTop.toFixed(2)} +${add}`); }
  if (ctx.pending === 'refund' && e.order_id) { scores.refund += 3; signals.push('refund: answers pending question +3'); }
  if (ctx.pending === 'appointment' && (e.day_offset != null || e.daypart || e.time)) { scores.appointment += 2; signals.push('appointment: answers pending question +2'); }
  return { scores, signals };
}

export function softmaxConfidence(scores) {
  const keys = Object.keys(scores);
  const exps = keys.map((k) => Math.exp(scores[k] * TEMP));
  const total = exps.reduce((a, b) => a + b, 0) + Math.exp(NONE_SCORE * TEMP);
  const probs = Object.fromEntries(keys.map((k, i) => [k, +(exps[i] / total).toFixed(3)]));
  // Ties go to the more specific intent (FAQ is listed first, so it only wins outright).
  // With no signal at all the label is 'faq' and the confidence is near zero.
  const max = Math.max(...keys.map((k) => scores[k]));
  const intent = max <= 0 ? keys[0] : keys.reduce((a, b) => (scores[b] >= scores[a] ? b : a), keys[0]);
  return { intent, confidence: probs[intent], probs };
}

export function classifyIntent(text, ctx = {}) {
  const { scores, signals } = scoreRules(text, ctx);
  const { intent, confidence, probs } = softmaxConfidence(scores);
  return { intent, confidence, probs, scores, signals, source: 'rules' };
}

// ---------- knowledge base retrieval ----------
export function searchKB(text, biz) {
  const q = [...new Set(tokens(text).filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w)))];
  if (!q.length) return { terms: [], hits: [] };
  const hits = biz.kb.map((entry) => {
    const keys = [...entry.keywords, ...tokens(entry.title)];
    const matched = q.filter((w) => keys.some((k) => termMatch(w, k)));
    return { id: entry.id, title: entry.title, score: +(matched.length / q.length).toFixed(2), matched };
  }).filter((h) => h.matched.length).sort((a, b) => b.score - a.score || b.matched.length - a.matched.length);
  return { terms: q, hits: hits.slice(0, 3) };
}

// Numbers in a drafted answer must all appear in the passages it cites.
export function groundingCheck(answer, passages) {
  const nums = (s) => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ''));
  const allowed = new Set(passages.flatMap((p) => nums(p)));
  const unsupported = nums(answer).filter((n) => !allowed.has(n));
  return { ok: unsupported.length === 0 && String(answer).trim().length > 0, unsupported };
}

// ---------- tools (mock back office) ----------
export function orderLookup(biz, { order_id, phone }) {
  if (order_id) {
    const r = biz.records.find((x) => x.id === order_id);
    return r ? { found: true, records: [r], by: 'order_id' } : { found: false, records: [], by: 'order_id' };
  }
  const rs = biz.records.filter((x) => x.phone === phone);
  return { found: rs.length > 0, records: rs, by: 'phone' };
}

export function listSlots(biz, now, { day_offset = null, daypart = null } = {}, booked = []) {
  const taken = new Set([...biz.taken, ...booked]);
  const inPart = (t) => {
    const h = Number(t.slice(0, 2));
    return !daypart || (daypart === 'morning' ? h < 12 : daypart === 'afternoon' ? h >= 12 && h < 16 : h >= 16);
  };
  const collect = (days, usePart) => {
    const out = [];
    for (const off of days) {
      const d = istDay(now, off);
      if (!biz.slot_days.includes(d.dow)) continue;
      for (const t of biz.slot_times) {
        const id = `d${off}-${t.replace(':', '')}`;
        if (taken.has(id) || (usePart && !inPart(t))) continue;
        out.push({ id, label: `${d.label}, ${fmtTime(t)}`, short: `${d.label.split(' ')[0]} ${fmtTime(t)}` });
      }
    }
    return out;
  };
  const range = [1, 2, 3, 4, 5, 6, 7];
  const notes = [];
  let days = day_offset != null && day_offset >= 1 ? [day_offset] : range;
  if (day_offset === 0) notes.push('Same-day slots are not bookable on WhatsApp; showing the next days.');
  if (day_offset != null && day_offset >= 1 && !biz.slot_days.includes(istDay(now, day_offset).dow)) {
    notes.push(`Closed on ${istDay(now, day_offset).label}; showing the next open days.`);
    days = range;
  }
  let slots = collect(days, true);
  if (!slots.length && daypart) { notes.push(`No ${daypart} slots left; showing other times.`); slots = collect(days, false); }
  if (!slots.length && days !== range) { notes.push('That day is full; showing the next open days.'); slots = collect(range, true); }
  return { slots: slots.slice(0, 4), notes };
}

export function bookSlot(biz, now, slotId, booked = []) {
  const m = /^d(\d)-(\d{2})(\d{2})$/.exec(String(slotId || ''));
  if (!m) return { ok: false, error: 'invalid_slot' };
  const time = `${m[2]}:${m[3]}`;
  const d = istDay(now, Number(m[1]));
  if (!biz.slot_days.includes(d.dow) || !biz.slot_times.includes(time) || Number(m[1]) < 1) return { ok: false, error: 'invalid_slot' };
  if (biz.taken.includes(slotId) || booked.includes(slotId)) return { ok: false, error: 'slot_taken' };
  return {
    ok: true,
    booking: { id: `APT-${hashId(biz.id + slotId + biz.customer.phone)}`, slot_id: slotId, label: `${d.label}, ${fmtTime(time)}`, service: biz.slot_service, name: biz.customer.name, advance: biz.id === 'smile' ? 300 : 0 },
  };
}

export function refundDecision(biz, record, { complaint = false } = {}) {
  if (complaint) return { action: 'handoff', code: 'complaint', reason: 'Refund request with a complaint needs a person.' };
  if (record.amount > biz.refund_auto_limit) return { action: 'handoff', code: 'refund_over_limit', reason: `${INR(record.amount)} is above the ${INR(biz.refund_auto_limit)} auto-refund limit.` };
  const done = ['delivered', 'completed', 'cancelled'].includes(record.status) || (record.status === 'active' && record.delivered_days_ago != null);
  if (!done) return { action: 'decline', code: 'not_eligible_yet', reason: `Status is ${record.status.replace(/_/g, ' ')}; refunds open after delivery.` };
  if ((record.delivered_days_ago ?? 0) > biz.refund_window_days) return { action: 'handoff', code: 'outside_window', reason: `Outside the ${biz.refund_window_days}-day window; a person must approve.` };
  return { action: 'auto', code: 'within_policy', reason: `${INR(record.amount)} within ${INR(biz.refund_auto_limit)} limit and ${biz.refund_window_days}-day window.` };
}

export function makeHandoff(biz, { code, reason, priority, message, intent, confidence, lang, turn = 0 }) {
  return {
    id: `HO-${hashId(biz.id + code + message + turn, 5)}`,
    queue: '#support-handoff',
    reason_code: code,
    reason,
    priority,
    customer: `${biz.customer.name} · ${maskPhone(biz.customer.phone)}`,
    last_message: String(message).slice(0, 200),
    intent, confidence, language: lang,
    sla: biz.handoff_sla,
    bot_paused: true,
  };
}

// ---------- reply copy ----------
const STATUS_TEXT = {
  shipped: ['has shipped', 'ship ho gaya hai'],
  out_for_delivery: ['is out for delivery', 'out for delivery hai'],
  delivered: ['was delivered', 'deliver ho chuka hai'],
  confirmed: ['is confirmed', 'confirmed hai'],
  completed: ['is completed', 'complete ho chuka hai'],
  cancelled: ['was cancelled', 'cancel ho chuka hai'],
  active: ['is active', 'active hai'],
};
const say = (lang, en, hi) => (lang === 'hinglish' ? hi : en);

function recordLine(biz, r, lang, now) {
  const st = STATUS_TEXT[r.status] || [r.status, r.status];
  const when = describeRecord(r, now);
  const courier = r.courier ? say(lang, ` with ${r.courier}`, ` ${r.courier} se`) : '';
  let tail = '';
  if (r.eta_in_days != null) tail = say(lang, `, arriving ${r.eta_in_days === 0 ? 'today' : 'by ' + istDay(now, r.eta_in_days).label}`, `, ${r.eta_in_days === 0 ? 'aaj' : istDay(now, r.eta_in_days).label + ' tak'} pahunch jayega`);
  else if (r.slot_in_days != null) tail = say(lang, ` for ${when}`, `, ${when}`);
  else if (r.delivered_days_ago != null) tail = say(lang, ` on ${istDay(now, -r.delivered_days_ago).label}`, ` (${istDay(now, -r.delivered_days_ago).label})`);
  const note = r.note ? ` ${r.note}` : '';
  return say(lang,
    `${biz.record_label} ${r.id} (${r.items}, ${INR(r.amount)}) ${st[0]}${courier}${tail}.${note}`,
    `${biz.record_label} ${r.id} (${r.items}, ${INR(r.amount)}) ${st[1]}${courier}${tail}.${note}`);
}

// ---------- the agent ----------
export async function runAgent({ businessId, message, replyId = null, state = {}, now = Date.now(), llm = null }) {
  const biz = BUSINESSES[businessId];
  if (!biz) throw new Error('unknown business');
  const text = String(message || '').trim().slice(0, MAX_MESSAGE);
  const booked = Array.isArray(state.booked) ? state.booked.filter((s) => typeof s === 'string').slice(0, 50) : [];
  const turn = Number(state.turn) || 0;
  const trace = [];
  const step = (stage, name, status, detail, extra = {}) => { trace.push({ stage, name, status, detail, ...extra }); };
  const out = { intent: null, confidence: null, probs: null, outcome: 'answered', handoff: null, booking: null, refund: null, chips: [], pending: null, booked, kb: [], model_used: false };

  const lang = detectLanguage(text);
  const L = lang.reply;
  step('input', 'Language', 'info', `${lang.code === 'en' ? 'English' : lang.code === 'hi' ? 'Hindi' : 'Hinglish'} · ${lang.reason}`);

  const finish = (replyText, chips = out.chips) => ({ ...out, chips, reply: { text: replyText, lang: L }, lang, trace, state: { pending: out.pending, booked: out.booked, turn: turn + 1 } });
  const handoff = (code, reason, priority, replyText) => {
    out.outcome = 'handoff';
    out.handoff = makeHandoff(biz, { code, reason, priority, message: text, intent: out.intent, confidence: out.confidence, lang: L, turn });
    step('tool', 'create_handoff', 'escalate', `Ticket ${out.handoff.id} posted to ${out.handoff.queue} (${priority} priority). Bot paused for this chat.`, { args: { reason_code: code, priority }, result: { ticket: out.handoff.id } });
    const t = replyText || say(L,
      `I have passed this to our team (ticket {id}). A person will reply here within ${biz.handoff_sla}.`,
      'Maine aapki baat team tak pahuncha di hai (ticket {id}). Ek team member jaldi yahin reply karega.');
    return finish(t.replace(/\{id\}/g, out.handoff.id), []);
  };

  // Guard 1: input
  step('guardrail', 'Input check', 'pass', `${text.length} / ${MAX_MESSAGE} characters`);

  // Guard 2: prompt injection
  if (checkInjection(text)) {
    out.intent = 'blocked'; out.confidence = 1; out.outcome = 'blocked';
    step('guardrail', 'Prompt injection', 'block', 'Message tries to change the agent\'s instructions. Not sent to the model; no discount or policy change applied.');
    return finish(say(L,
      'I can only help with questions about our products, orders, refunds and bookings, using our published policies. I cannot change prices or apply custom discounts.',
      'Main sirf products, orders, refunds aur bookings mein hamari published policies ke hisaab se madad kar sakta hoon. Prices ya custom discount change nahi kar sakta.'), biz.chips);
  }
  step('guardrail', 'Prompt injection', 'pass', 'No instruction override detected');

  // Button replies and small talk
  const cleaned = text.toLowerCase().replace(/[^a-z\s]/g, ' ').trim();
  if (!replyId && /^(hi+|hello|hey|hlo|namaste|namaskar|good (morning|afternoon|evening))( there| ji)?$/.test(cleaned)) {
    out.intent = 'greeting'; out.confidence = 1;
    step('classify', 'Intent', 'info', 'Greeting, answered with the welcome message and quick replies');
    return finish(biz.greeting[L === 'hinglish' ? 'hi' : 'en'], biz.chips);
  }
  if (!replyId && /^(thanks?( you)?( so much)?|thank u|thx|ty|ok(ay)?( thanks?)?|shukriya|dhanyavaa?d|great|cool|done)$/.test(cleaned)) {
    out.intent = 'greeting'; out.confidence = 1;
    step('classify', 'Intent', 'info', 'Closing message, no action needed');
    return finish(say(L, 'Happy to help. Message here any time.', 'Khushi hui madad karke. Kabhi bhi yahan message kariye.'), []);
  }

  const entities = extractEntities(text, now);
  const kb = searchKB(text, biz);
  out.kb = kb.hits;
  const kbTop = kb.hits[0]?.score || 0;

  // Classification: button id > model (live) > rules
  const ruleResult = classifyIntent(text, { entities, kbTop, pending: state.pending });
  let cls = ruleResult;
  const BUTTON = { 'q:track': 'order_status', 'q:book': 'appointment', 'q:human': 'human', 'q:cod': 'faq', 'q:timings': 'faq', 'q:fees': 'faq' };
  if (replyId && (BUTTON[replyId] || /^(slot|refund|order):/.test(replyId))) {
    const intent = BUTTON[replyId] || { slot: 'appointment', refund: 'refund', order: 'order_status' }[replyId.split(':')[0]];
    cls = { ...ruleResult, intent, confidence: 1, source: 'button' };
    if (replyId.startsWith('refund:') || replyId.startsWith('order:')) entities.order_id = replyId.split(':')[1];
  } else if (llm) {
    const m = await llm.classify({ text, business: biz, intents: INTENTS }).catch(() => null);
    if (m && INTENTS.includes(m.intent) && typeof m.confidence === 'number') {
      cls = { ...ruleResult, intent: m.intent, confidence: Math.max(0, Math.min(1, +m.confidence.toFixed(3))), source: 'model' };
      out.model_used = true;
    } else step('classify', 'Model classifier', 'info', 'Model unavailable or invalid JSON; fell back to rules');
  }
  out.intent = cls.intent; out.confidence = cls.confidence; out.probs = cls.probs; out.scores = cls.scores; out.signals = cls.signals;
  step('classify', 'Intent', 'info', `${cls.intent} · confidence ${cls.confidence.toFixed(2)} · ${cls.source === 'button' ? `quick reply id ${replyId}` : cls.source === 'model' ? 'Gemini 2.0 Flash' : 'rule signals'}`, { signals: cls.signals.slice(0, 6) });
  const ent = Object.entries(entities).filter(([, v]) => v != null);
  step('classify', 'Entities', 'info', ent.length ? ent.map(([k, v]) => `${k}=${k === 'phone' ? maskPhone(v) : v}`).join(' · ') : 'None found');

  const complaintSignal = cls.scores.complaint > 0;
  const medical = checkMedical(text);

  // Explicit human request and complaints always escalate.
  if (cls.intent === 'human') {
    step('guardrail', 'Escalation policy', 'escalate', 'Customer asked for a person');
    return handoff('asked_for_human', 'Customer asked for a person.', 'normal');
  }
  if (cls.intent === 'complaint') {
    step('guardrail', 'Escalation policy', 'escalate', 'Complaint detected; complaints are always handled by a person');
    return handoff('complaint', 'Complaint: needs an apology and a human decision.', 'high', say(L,
      `I am sorry about this experience. I have flagged it to our team as high priority (ticket {id}). A person will reply here within ${biz.handoff_sla}.`,
      'Is experience ke liye hum maafi chahte hain. Maine ise team ko high priority par bhej diya hai (ticket {id}). Team member jaldi yahin reply karega.'));
  }

  // Medical questions are never answered by the bot.
  if (medical && cls.intent !== 'order_status' && cls.intent !== 'appointment') {
    out.outcome = 'refused';
    step('guardrail', 'Medical advice', 'refuse', 'Medical or safety question. The bot does not give medical advice, even when the KB has related products.');
    return finish(say(L,
      `I cannot give medical advice. Please check with your doctor${biz.id === 'smile' ? ', or book a check-up and our dentist will advise you' : ''}. I can connect you to our team if you want.`,
      `Main medical advice nahi de sakta. Kripya apne doctor se poochiye${biz.id === 'smile' ? ', ya check-up book kariye, hamare dentist aapko sahi salah denge' : ''}. Chahein to main aapko team se connect kar deta hoon.`),
    [{ id: 'q:human', title: say(L, 'Talk to a person', 'Team se baat karein') }, ...(biz.id === 'smile' ? [{ id: 'q:book', title: say(L, 'Book a check-up', 'Check-up book karein') }] : [])]);
  }

  // Low confidence escalates instead of guessing.
  if (cls.confidence < CONFIDENCE_FLOOR) {
    step('guardrail', 'Confidence floor', 'escalate', `${cls.confidence.toFixed(2)} < ${CONFIDENCE_FLOOR}: the agent does not guess`);
    return handoff('low_confidence', `Intent unclear (confidence ${cls.confidence.toFixed(2)}).`, 'normal', say(L,
      `I want to make sure you get the right answer, so I have asked a team member to take over (ticket {id}). They will reply here within ${biz.handoff_sla}.`,
      `Sahi jawab mile isliye maine team member ko bula liya hai (ticket {id}). Woh jaldi yahin reply karenge.`));
  }
  step('guardrail', 'Confidence floor', 'pass', `${cls.confidence.toFixed(2)} ≥ ${CONFIDENCE_FLOOR}`);

  // Privacy: a phone number in the text must be the sender's own WhatsApp number.
  if (entities.phone && entities.phone !== biz.customer.phone && (cls.intent === 'order_status' || cls.intent === 'refund')) {
    out.outcome = 'refused';
    step('guardrail', 'Identity check', 'refuse', `Requested ${maskPhone(entities.phone)} is not the sender ${maskPhone(biz.customer.phone)}`);
    return finish(say(L,
      'For privacy I can only share details linked to the WhatsApp number you are messaging from.',
      'Privacy ke liye main sirf usi WhatsApp number se linked details share kar sakta hoon jisse aap message kar rahe hain.'), []);
  }

  // ---------- FAQ ----------
  if (cls.intent === 'faq') {
    step('tool', 'kb_search', kbTop >= KB_MIN_SCORE ? 'pass' : 'info', kb.hits.length ? kb.hits.map((h) => `${h.id} ${h.score.toFixed(2)}`).join(' · ') : 'No entry matched', { args: { query_terms: kb.terms }, result: kb.hits });
    if (kbTop < KB_MIN_SCORE) {
      out.outcome = 'refused';
      step('guardrail', 'KB grounding', 'refuse', `Best match ${kbTop.toFixed(2)} < ${KB_MIN_SCORE}. Not covered by the knowledge base, so the agent will not answer.`);
      return finish(say(L,
        `I do not have verified information about that, so I will not guess. A person from ${biz.name} can answer it.`,
        `Iske baare mein mere paas verified jaankari nahi hai, isliye main guess nahi karunga. ${biz.name} ki team aapko bata sakti hai.`),
      [{ id: 'q:human', title: say(L, 'Talk to a person', 'Team se baat karein') }]);
    }
    const used = kb.hits.filter((h) => h.score >= KB_MIN_SCORE).slice(0, 2).map((h) => biz.kb.find((k) => k.id === h.id));
    let answer = used.map((k) => k[L === 'hinglish' ? 'hi' : 'en']).join(' ');
    let source = 'template';
    if (llm) {
      const draft = await llm.compose({ text, lang: L, business: biz, passages: used.map((k) => ({ id: k.id, text: k[L === 'hinglish' ? 'hi' : 'en'] })) }).catch(() => null);
      if (draft && draft.covered !== false && typeof draft.answer === 'string') {
        const g = groundingCheck(draft.answer, used.flatMap((k) => [k.en, k.hi]));
        const idsOk = Array.isArray(draft.used_ids) && draft.used_ids.every((i) => used.some((k) => k.id === i));
        if (g.ok && idsOk) { answer = draft.answer.slice(0, 700); source = 'model'; out.model_used = true; }
        else step('guardrail', 'Model draft check', 'block', `Draft rejected (${!idsOk ? 'cited an entry it was not given' : 'unsupported numbers: ' + g.unsupported.join(', ')}); using the KB text verbatim`);
      }
    }
    step('guardrail', 'KB grounding', 'pass', `Answer built only from ${used.map((k) => k.id).join(' + ')} (${source === 'model' ? 'model wording, numbers verified' : 'verbatim KB text'})`);
    out.sources = used.map((k) => k.id);
    return finish(answer, []);
  }

  // ---------- Order / booking status ----------
  if (cls.intent === 'order_status') {
    const args = entities.order_id ? { order_id: entities.order_id } : { phone: biz.customer.phone };
    const r = orderLookup(biz, args);
    step('tool', 'order_lookup', r.found ? 'pass' : 'info', r.found ? `${r.records.length} record(s) via ${r.by}` : 'No match', { args: args.phone ? { phone: maskPhone(args.phone) } : args, result: r.records.map((x) => ({ id: x.id, status: x.status, amount: x.amount })) });
    if (!r.found) {
      out.outcome = 'needs_info'; out.pending = null;
      return finish(say(L,
        entities.order_id ? `I could not find ${biz.record_label.toLowerCase()} ${entities.order_id}. Please check the ID; it looks like ${biz.id_prefix}-12345.` : `I could not find any ${biz.record_label.toLowerCase()} on this number. Please share the ${biz.record_label.toLowerCase()} ID; it looks like ${biz.id_prefix}-12345.`,
        entities.order_id ? `${entities.order_id} naam ka ${biz.record_label.toLowerCase()} nahi mila. ID check kariye, format ${biz.id_prefix}-12345 jaisa hota hai.` : `Is number par koi ${biz.record_label.toLowerCase()} nahi mila. ${biz.record_label} ID bhejiye, format ${biz.id_prefix}-12345.`), []);
    }
    const mine = r.records.filter((x) => x.phone === biz.customer.phone);
    if (!mine.length) {
      out.outcome = 'refused';
      step('guardrail', 'Identity check', 'refuse', `${entities.order_id} belongs to a different phone number; details withheld`);
      return finish(say(L,
        `${biz.record_label} ${entities.order_id} is not linked to this WhatsApp number, so I cannot share its details. Please message from the number used at checkout.`,
        `${biz.record_label} ${entities.order_id} is WhatsApp number se linked nahi hai, isliye details share nahi kar sakta. Jo number checkout par diya tha usse message kariye.`), []);
    }
    step('guardrail', 'Identity check', 'pass', `Records belong to sender ${maskPhone(biz.customer.phone)}; address and payment details are never shown`);
    const DONE = ['delivered', 'completed', 'cancelled'];
    const open = mine.filter((x) => !DONE.includes(x.status));
    const shown = (open.length ? open : mine).slice(0, 2);
    const lines = shown.map((x) => recordLine(biz, x, L, now));
    const rest = mine.length - shown.length;
    const intro = !entities.order_id && open.length ? say(L, `On your number, ${open.length} ${open.length === 1 ? 'is' : 'are'} in progress:\n`, `Aapke number par ${open.length} ${biz.record_label.toLowerCase()} abhi process mein hai:\n`) : '';
    const more = !entities.order_id && rest > 0 ? say(L, `\n${rest} older ${rest === 1 ? 'one is' : 'are'} closed. Send an ID for details.`, `\n${rest} purane closed hain. Details ke liye ID bhejiye.`) : '';
    return finish(intro + lines.join('\n') + more, []);
  }

  // ---------- Refund ----------
  if (cls.intent === 'refund') {
    if (!entities.order_id) {
      const r = orderLookup(biz, { phone: biz.customer.phone });
      step('tool', 'order_lookup', r.found ? 'pass' : 'info', `${r.records.length} record(s) via phone, asking which one`, { args: { phone: maskPhone(biz.customer.phone) }, result: r.records.map((x) => ({ id: x.id, status: x.status, amount: x.amount })) });
      out.outcome = 'needs_info'; out.pending = 'refund';
      return finish(say(L, `Which ${biz.record_label.toLowerCase()} is the refund for?`, `Refund kis ${biz.record_label.toLowerCase()} ke liye chahiye?`),
        r.records.slice(0, 3).map((x) => ({ id: `refund:${x.id}`, title: `${x.id} · ${INR(x.amount)}` })));
    }
    const r = orderLookup(biz, { order_id: entities.order_id });
    step('tool', 'order_lookup', r.found ? 'pass' : 'info', r.found ? `${entities.order_id} · ${r.records[0].status} · ${INR(r.records[0].amount)}` : 'No match', { args: { order_id: entities.order_id }, result: r.records.map((x) => ({ id: x.id, status: x.status, amount: x.amount })) });
    if (!r.found) {
      out.outcome = 'needs_info'; out.pending = 'refund';
      return finish(say(L, `I could not find ${entities.order_id}. Please check the ID.`, `${entities.order_id} nahi mila. ID check kariye.`), []);
    }
    const rec = r.records[0];
    if (rec.phone !== biz.customer.phone) {
      out.outcome = 'refused';
      step('guardrail', 'Identity check', 'refuse', `${rec.id} belongs to a different phone number`);
      return finish(say(L, `${rec.id} is not linked to this WhatsApp number, so I cannot raise a refund for it.`, `${rec.id} is WhatsApp number se linked nahi hai, isliye refund raise nahi kar sakta.`), []);
    }
    step('guardrail', 'Identity check', 'pass', `${rec.id} belongs to the sender`);
    const d = refundDecision(biz, rec, { complaint: complaintSignal });
    out.refund = { order_id: rec.id, amount: rec.amount, limit: biz.refund_auto_limit, decision: d.action, code: d.code };
    if (d.action === 'handoff') {
      step('guardrail', 'Refund limit', 'escalate', d.reason);
      return handoff(d.code, d.reason, d.code === 'complaint' ? 'high' : 'normal', say(L,
        `${d.code === 'complaint' ? 'I am sorry about this. ' : ''}A refund of ${INR(rec.amount)} for ${rec.id} needs approval from our team, so I have passed it on (ticket {id}). A person will reply here within ${biz.handoff_sla}.`,
        `${d.code === 'complaint' ? 'Iske liye maafi chahte hain. ' : ''}${rec.id} ke ${INR(rec.amount)} refund ke liye team ka approval chahiye, maine request aage bhej di hai (ticket {id}). Team member jaldi yahin reply karega.`));
    }
    if (d.action === 'decline') {
      step('guardrail', 'Refund policy', 'refuse', d.reason);
      out.outcome = 'answered';
      return finish(say(L,
        `${rec.id} ${STATUS_TEXT[rec.status]?.[0] || 'is in progress'}, so a refund can be requested once it is delivered. Unopened items can be returned within ${biz.refund_window_days} days of delivery.`,
        `${rec.id} abhi ${STATUS_TEXT[rec.status]?.[1] || 'process mein hai'}, delivery ke baad refund request kar sakte hain. Unopened items delivery ke ${biz.refund_window_days} din ke andar return ho sakte hain.`), []);
    }
    step('guardrail', 'Refund limit', 'pass', d.reason);
    const rf = `RF-${hashId(rec.id + biz.customer.phone)}`;
    step('tool', 'initiate_refund', 'pass', `${rf} · ${INR(rec.amount)} to original payment method`, { args: { order_id: rec.id, amount: rec.amount }, result: { refund_id: rf, status: 'initiated' } });
    out.refund.refund_id = rf;
    return finish(say(L,
      `Done. Refund ${rf} for ${INR(rec.amount)} on ${rec.id} is initiated to your original payment method.${biz.id === 'glow' ? ' Our courier will pick up the unopened item within 2 days.' : ''} It usually reflects in 5 to 7 working days.`,
      `Ho gaya. ${rec.id} ka ${INR(rec.amount)} refund (${rf}) original payment method mein initiate kar diya hai.${biz.id === 'glow' ? ' Courier 2 din mein unopened item pick up karega.' : ''} Usually 5 se 7 working days mein dikh jata hai.`), []);
  }

  // ---------- Appointment ----------
  if (cls.intent === 'appointment') {
    let slotId = replyId && replyId.startsWith('slot:') ? replyId.slice(5) : null;
    if (!slotId && entities.time && entities.day_offset != null) {
      slotId = `d${entities.day_offset}-${entities.time.replace(':', '')}`;
    }
    if (slotId) {
      const b = bookSlot(biz, now, slotId, booked);
      step('tool', 'book_slot', b.ok ? 'pass' : 'info', b.ok ? `${b.booking.id} · ${b.booking.label}` : `Not booked: ${b.error.replace('_', ' ')}`, { args: { slot_id: slotId, name: biz.customer.name }, result: b.ok ? b.booking : { error: b.error } });
      if (b.ok) {
        out.booking = b.booking; out.booked = [...booked, slotId];
        step('guardrail', 'Double booking', 'pass', 'Slot was free and is now held');
        return finish(say(L,
          `Booked. Your ${biz.slot_service} is on ${b.booking.label} (ID ${b.booking.id}).${b.booking.advance ? ` A ₹${b.booking.advance} advance link will follow, adjusted in your bill.` : ''} Reply CANCEL to cancel.`,
          `Book ho gaya. Aapka ${biz.slot_service} ${b.booking.label} ko hai (ID ${b.booking.id}).${b.booking.advance ? ` ₹${b.booking.advance} advance ka link aayega, jo bill mein adjust hoga.` : ''} Cancel karne ke liye CANCEL likhiye.`), []);
      }
      step('guardrail', 'Double booking', 'block', b.error === 'slot_taken' ? 'Slot already taken, offering alternatives' : 'Requested time is not an open slot');
    }
    const s = listSlots(biz, now, { day_offset: entities.day_offset, daypart: entities.daypart }, booked);
    step('tool', 'list_slots', s.slots.length ? 'pass' : 'info', `${s.slots.length} open${s.notes.length ? ' · ' + s.notes.join(' ') : ''}`, { args: { day_offset: entities.day_offset, daypart: entities.daypart }, result: s.slots.map((x) => x.id) });
    out.pending = 'appointment'; out.outcome = 'needs_info';
    if (!s.slots.length) return finish(say(L, 'No slots are open this week. I can ask the team to call you.', 'Is hafte koi slot khaali nahi hai. Team se call karwa sakta hoon.'), [{ id: 'q:human', title: 'Talk to a person' }]);
    return finish(say(L,
      `${s.notes.length ? s.notes[0] + ' ' : ''}Here are the next open slots for a ${biz.slot_service}. Tap one to book.`,
      `${biz.slot_service} ke liye ye slots khaali hain. Book karne ke liye ek select kariye.`),
    s.slots.map((x) => ({ id: `slot:${x.id}`, title: x.label })));
  }

  return handoff('unhandled', 'No route for this intent.', 'normal');
}

// GET /api/businesses · the three business presets as the browser may see them
// (KB, mock records and scenarios; other customers' phone numbers are withheld).
import { BUSINESSES, publicBusiness } from './_businesses.js';
import { CONFIDENCE_FLOOR, KB_MIN_SCORE, MAX_MESSAGE } from './_agent.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'GET only' });
  }
  const now = Date.now();
  return res.status(200).json({
    limits: { confidence_floor: CONFIDENCE_FLOOR, kb_min_score: KB_MIN_SCORE, max_message: MAX_MESSAGE },
    businesses: Object.values(BUSINESSES).map((b) => publicBusiness(b, now)),
  });
}

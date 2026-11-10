// Vercel serverless function: POST /api/osm  { "q": "<Overpass QL query>" }
// Runs the OpenStreetMap (Overpass) query from Vercel's servers, which reach the
// public Overpass servers much more reliably than some home or mobile networks.
// It asks several servers at once and merges what comes back.
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter'
];

function ask(url, q, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'HuntingDesk/1.0 (lead research tool)', Accept: 'application/json' },
    body: 'data=' + encodeURIComponent(q),
    signal: ctrl.signal
  }).then(async (r) => {
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.remark && /error|timed out|out of memory/i.test(j.remark) && !(j.elements && j.elements.length)) throw new Error('overloaded');
    return j;
  }, (e) => { clearTimeout(timer); throw e; });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const q = body && typeof body.q === 'string' ? body.q : '';
  if (!/^\[out:json\]/.test(q) || q.length > 6000) { res.status(400).json({ error: 'bad query' }); return; }
  const seen = {}, elements = [], errs = [];
  let ok = 0, hits = 0;
  await new Promise((resolve) => {
    let pending = SERVERS.length, grace = null;
    const fin = () => { clearTimeout(grace); resolve(); };
    SERVERS.forEach((u) => {
      ask(u, q, 9000).then((j) => {
        ok++;
        if (j.elements && j.elements.length) {
          hits++;
          j.elements.forEach((el) => { const k = el.type + ':' + el.id; if (!seen[k]) { seen[k] = 1; elements.push(el); } });
          if (hits === 1) grace = setTimeout(fin, 1500);
        }
      }, (e) => {
        errs.push(new URL(u).host + ': ' + (e && e.name === 'AbortError' ? 'no answer' : (e && e.message) || 'error'));
      }).then(() => { if (--pending === 0) fin(); });
    });
  });
  if (!ok) { res.status(502).json({ error: errs.join('; ') || 'no server answered' }); return; }
  res.status(200).json({ elements, servers: ok });
};
module.exports.config = { maxDuration: 15 };

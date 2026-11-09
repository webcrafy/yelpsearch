// Vercel serverless function: GET /api/site-scan?url=<business website>
// Reads the business's own public homepage and lists the social links, WhatsApp
// number, emails and phones it publishes. It never touches Yelp or Google.
const dns = require('dns').promises;
const net = require('net');

const PLATFORMS = {
  facebook: /(^|\.)(facebook\.com|fb\.com)$/i,
  instagram: /(^|\.)instagram\.com$/i,
  linkedin: /(^|\.)linkedin\.com$/i,
  tiktok: /(^|\.)tiktok\.com$/i,
  youtube: /(^|\.)(youtube\.com|youtu\.be)$/i,
  x: /(^|\.)(x\.com|twitter\.com)$/i,
  pinterest: /(^|\.)pinterest\.com$/i,
  nextdoor: /(^|\.)nextdoor\.com$/i
};
const BAD_PATH = /(sharer|\/share|intent\/|\/plugins|\/tr\?|\/tr\/|\/dialog|\/login|\/policies|\/help|\/legal|\/privacy|\/embed|\/hashtag|\/explore|\/oauth|\/signup|\/ads\/|\/p\/|\/reel|\/watch|\/tos|\/terms)/i;

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

async function assertPublicHost(hostname) {
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('blocked address');
}

async function readCapped(res, cap) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(Buffer.from(value));
    if (size >= cap) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPage(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(url.hostname);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadDeskSiteCheck/1.0)', Accept: 'text/html,application/xhtml+xml' }
      });
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      if (!/^https?:$/.test(url.protocol)) throw new Error('bad redirect');
      continue;
    }
    const type = res.headers.get('content-type') || '';
    if (!/html|xml|text/i.test(type)) return { html: '', status: res.status, finalUrl: url.href };
    return { html: await readCapped(res, 1500000), status: res.status, finalUrl: url.href };
  }
  throw new Error('too many redirects');
}

function extract(rawHtml) {
  const html = String(rawHtml || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/');
  const social = {};
  const urlRe = /https?:\/\/[a-z0-9.\-]+\.[a-z]{2,}\/[^\s"'<>\\)]+/gi;
  let m;
  while ((m = urlRe.exec(html))) {
    let u = m[0].replace(/[.,;:]+$/, '');
    let parsed;
    try { parsed = new URL(u); } catch (e) { continue; }
    for (const key of Object.keys(PLATFORMS)) {
      if (social[key] || !PLATFORMS[key].test(parsed.hostname)) continue;
      const path = parsed.pathname + parsed.search;
      if (parsed.pathname.length < 2 || BAD_PATH.test(path)) continue;
      social[key] = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }
  }
  let whatsapp = '';
  const wa = html.match(/wa\.me\/(?:message\/)?(\+?\d{7,15})/i) ||
    html.match(/api\.whatsapp\.com\/send\/?\?[^"'\s]*phone=(\+?\d{7,15})/i) ||
    html.match(/whatsapp:\/\/send\?[^"'\s]*phone=(\+?\d{7,15})/i);
  if (wa) whatsapp = wa[1].replace(/\D/g, '');
  const emails = [];
  const emailRe = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
  while ((m = emailRe.exec(html)) && emails.length < 3) {
    const e = m[0].toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) || /(sentry|wixpress|example\.com|domain\.com|yourdomain|email\.com$)/.test(e)) continue;
    if (emails.indexOf(e) === -1) emails.push(e);
  }
  const phones = [];
  const telRe = /href=["']tel:([+\d()\-.\s%]{7,22})["']/gi;
  while ((m = telRe.exec(html)) && phones.length < 3) {
    const p = decodeURIComponent(m[1]).trim();
    if (phones.indexOf(p) === -1) phones.push(p);
  }
  const t = html.match(/<title[^>]*>([^<]{1,160})<\/title>/i);
  return { social, whatsapp, emails, phones, title: t ? t[1].trim() : '' };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'not allowed from another site' }); } catch (e) {}
  }
  const raw = String((req.query && req.query.url) || '').trim();
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { return res.status(400).json({ error: 'bad website address' }); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.')) return res.status(400).json({ error: 'bad website address' });
  try {
    const page = await fetchPage(url);
    return res.status(200).json(Object.assign({ ok: true, status: page.status, finalUrl: page.finalUrl }, extract(page.html)));
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'the site took too long' : (e && e.message) || 'fetch failed';
    return res.status(502).json({ error: msg });
  }
};
module.exports.extract = extract;
module.exports.isPrivate = isPrivate;

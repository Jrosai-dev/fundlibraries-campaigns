// scripts/build_cards.js
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

/** EDIT if you ever change repo */
const REPO_SLUG = 'Jrosai-dev/fundlibraries-campaigns';
const CDN_BASE  = `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@main/public/`;

/** Your two web apps */
const CAMPAIGNS_URL = 'https://script.google.com/macros/s/AKfycbyiouHm4YRuReOn73FR_uLr7wJpBTW4QhCaXb9a12x3_wuYMll9FiBPj9lPQcOFhkAfRA/exec';
const UPDATES_URL   = 'https://script.google.com/macros/s/AKfycbw21MCIKLKDMUZmsDP0AAvnmsGwCN1TYHviqcUmArJDOW8y1LdpMFvFugXY4iWI4nUz4A/exec';

const OUT_DIR  = path.join(__dirname, '..', 'public');
const OUT_FILE = path.join(OUT_DIR, 'campaigns.cards.min.json'); // canonical

function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'user-agent': 'github-actions',
        'accept': 'application/json,text/plain;q=0.9,*/*;q=0.8',
        'accept-encoding': 'identity'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return fetchText(next, redirects - 1).then(resolve, reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}. Preview: ${data.slice(0,300)}`));
        }
        resolve(data);
      });
    });
    req.on('error', reject);
  });
}

function parsePossiblyQuotedJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const t = String(text || '').trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    const unwrapped = t.slice(1, -1);
    try { return JSON.parse(unwrapped); } catch (_) {}
    try {
      const inner = JSON.parse(t);
      if (typeof inner === 'string') return JSON.parse(inner);
    } catch (_) {}
  }
  throw new Error('Response was not valid JSON. Preview: ' + t.slice(0, 500));
}

function numish(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$, ]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function cleanStr(v) {
  if (v == null) return '';
  const s = String(v).trim();
  const sl = s.toLowerCase();
  if (sl === 'undefined' || sl === 'null') return '';
  return s;
}
function splitLocation(loc) {
  if (!loc) return { city: '', state: '' };
  const parts = String(loc).split(',').map(s => s.trim());
  return { city: parts[0] || '', state: parts[1] || '' };
}
function parseDateAny(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function fmtPretty(d) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(d);
}

/** Map a campaign row to your card shape */
function mapCampaign(c) {
  const city  = cleanStr(c.city)  || splitLocation(c.location).city;
  const state = cleanStr(c.state) || splitLocation(c.location).state;
  const location = cleanStr(c.location) || [city, state].filter(Boolean).join(', ');

  return {
    id: cleanStr(c.slug),
    slug: cleanStr(c.slug),

    title: cleanStr(c.campaign_name) || cleanStr(c.title) || 'Untitled',
    short: cleanStr(c.short_blurb)   || cleanStr(c.excerpt),
    description: cleanStr(c.long_description) || cleanStr(c.description),
    img: cleanStr(c.image_url) || cleanStr(c.featured_image),

    raised: numish(c.raised),
    goal:   numish(c.goal_amount) || numish(c.funding_goal),

    category: cleanStr(c.category),
    location,
    city,
    state,

    organization: cleanStr(c.org_name) || cleanStr(c.organization),
    status: cleanStr(c.status),

    start_date: cleanStr(c.start_date) || '',
    end_date:   cleanStr(c.end_date)   || '',
    created_at: cleanStr(c.created_at) || '',

    updated_at: cleanStr(c.updated_at) || cleanStr(c.end_date) || cleanStr(c.created_at) || ''
  };
}

/** True for public cards */
function isPublic(card) {
  return String(card.status || '').toLowerCase() === 'active';
}

/** Normalize an update to a simple shape and compute iso and pretty date */
function mapUpdate(u) {
  const slug = cleanStr(u.slug);
  const content = cleanStr(u.content);
  const rawDate = u.date != null ? u.date : u.updated_at; // allow either
  const d = parseDateAny(rawDate);
  const date_iso = d ? d.toISOString() : '';
  const date_pretty = d ? fmtPretty(d) : cleanStr(rawDate); // fallback to raw if unparseable
  return { slug, date: date_pretty, date_iso, content };
}

/** Group updates by slug and sort newest first within each group */
function groupUpdatesBySlug(updates) {
  const by = new Map();
  for (const u of updates) {
    if (!u.slug) continue;
    if (!by.has(u.slug)) by.set(u.slug, []);
    by.get(u.slug).push(u);
  }
  for (const arr of by.values()) {
    arr.sort((a, b) => new Date(b.date_iso || 0) - new Date(a.date_iso || 0));
  }
  return by;
}

function utcStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    pad(d.getUTCHours()),
    pad(d.getUTCMinutes())
  ].join('');
}

(async function main() {
  try {
    // Fetch both sources
    const [campaignsText, updatesText] = await Promise.all([
      fetchText(CAMPAIGNS_URL),
      fetchText(UPDATES_URL)
    ]);
    const campaignsRoot = parsePossiblyQuotedJSON(campaignsText);
    const updatesRoot   = parsePossiblyQuotedJSON(updatesText);

    // Be flexible about shapes
    const rawCampaigns =
      Array.isArray(campaignsRoot?.front)     ? campaignsRoot.front :
      Array.isArray(campaignsRoot?.campaigns) ? campaignsRoot.campaigns :
      Array.isArray(campaignsRoot)            ? campaignsRoot :
      [];

    const rawUpdates =
      Array.isArray(updatesRoot?.updates) ? updatesRoot.updates :
      Array.isArray(updatesRoot)          ? updatesRoot :
      [];

    // Normalize
    const cardsBase = rawCampaigns.map(mapCampaign).filter(isPublic);
    const updates   = rawUpdates.map(mapUpdate);

    // Group updates and merge into cards
    const bySlug = groupUpdatesBySlug(updates);
    const cards = cardsBase.map(card => {
      const ups = bySlug.get(card.slug) || [];
      // If we have updates, set updated_at to the newest update iso
      if (ups.length && ups[0].date_iso) {
        card.updated_at = ups[0].date_iso;
      }
      // Attach updates array with pretty date and iso
      return { ...card, updates: ups };
    });

    // Sort cards by updated_at desc
    cards.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    // Write canonical
    fs.writeFileSync(OUT_FILE, JSON.stringify(cards), 'utf8');

    // Versioned filename: time + content hash
    const stamp = utcStamp();
    const hash  = crypto.createHash('sha1').update(JSON.stringify(cards)).digest('hex').slice(0, 8);
    const versionedName = `campaigns.cards.${stamp}.${hash}.min.json`;
    const versionedPath = path.join(OUT_DIR, versionedName);

    fs.writeFileSync(versionedPath, JSON.stringify(cards), 'utf8');

    // Manifest that points to the versioned CDN URL
    const manifest = {
      url: CDN_BASE + versionedName,
      stamp,
      hash,
      updated_at: new Date().toISOString(),
      count: cards.length
    };
    fs.writeFileSync(path.join(OUT_DIR, 'cards.latest.json'), JSON.stringify(manifest), 'utf8');

    console.log('Wrote:');
    console.log('  ', OUT_FILE);
    console.log('  ', versionedPath);
    console.log('  ', path.join(OUT_DIR, 'cards.latest.json'));
  } catch (err) {
    console.error('Build failed:', err.stack || err.message);
    process.exit(1);
  }
})();

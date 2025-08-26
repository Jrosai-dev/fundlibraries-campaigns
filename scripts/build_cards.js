const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** EDIT if you ever change repo */
const REPO_SLUG = 'Jrosai-dev/fundlibraries-campaigns';
const CDN_BASE  = `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@main/public/`;

/** New public JSON endpoint + explicit src=front */
const SOURCE_URL =
  'https://script.googleusercontent.com/macros/echo?user_content_key=AehSKLi3zb1HHQlCSeyF6ApqsVvl4cKBTM2mZDpL2xFJgTtJCGFECsWS4NOIFD2wedKwm9Z41xWof3xQSGSawrlKLT13MXkSN-5-Cs-hYmO6UtgS9NfL4rM5icEEHuGrS8Jq0nlszCFnyGD_iXcZWeS8hcSk53kAgWco4TLGnvVSNy9VO9PEQSJAypsd93HuIr9PYaYucgmJS5OL-3k4n5AgKp1mCnpFiBB1Igo-5TFeBc8nnFxvEvPTRtc0tp9c7ruPcDW0VOSh9oyV6GlC5cfQCFxa0WZyXRQuL3P9Ezg1&lib=MVMIYV6saYybDBeuj7IgiPNHZPnF7WrD1&src=front';

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
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    const unwrapped = t.slice(1, -1);
    try { return JSON.parse(unwrapped); } catch (_) {}
    try {
      const inner = JSON.parse(t);
      if (typeof inner === 'string') return JSON.parse(inner);
    } catch (_) {}
  }
  throw new Error('Response was not valid JSON. Preview: ' + text.slice(0, 500));
}

function splitLocation(loc) {
  if (!loc) return { city: '', state: '' };
  const parts = String(loc).split(',').map(s => s.trim());
  return { city: parts[0] || '', state: parts[1] || '' };
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

function mapOne(c) {
  // Prefer explicit city and state, else derive from location
  const city  = cleanStr(c.city)  || splitLocation(c.location).city;
  const state = cleanStr(c.state) || splitLocation(c.location).state;

  // Prefer explicit combined location if present, else build from city and state
  const location = cleanStr(c.location) || [city, state].filter(Boolean).join(', ');

  // New headers mapping
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

    // Dates: only end_date is guaranteed in the new sheet
    start_date: cleanStr(c.start_date) || '',
    end_date:   cleanStr(c.end_date)   || '',
    created_at: cleanStr(c.created_at) || '',

    // Sort key fallback
    updated_at: cleanStr(c.updated_at) || cleanStr(c.end_date) || cleanStr(c.created_at) || ''
  };
}

function isPublic(c) {
  return String(c.status || '').toLowerCase() === 'active';
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
    const text = await fetchText(SOURCE_URL);
    const root = parsePossiblyQuotedJSON(text);

    // New API returns { front: [...] }. Keep back compat for { campaigns: [...] } or raw array.
    const campaigns =
      Array.isArray(root?.front)      ? root.front      :
      Array.isArray(root?.campaigns)  ? root.campaigns  :
      Array.isArray(root)             ? root            :
      [];

    const cards = campaigns.filter(isPublic).map(mapOne);

    // Sort by updated_at if present, else stable
    cards.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    // Write canonical
    fs.writeFileSync(OUT_FILE, JSON.stringify(cards), 'utf8');

    // Versioned filename: time + content hash
    const stamp = utcStamp(); // e.g. 202507011122
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

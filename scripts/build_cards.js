// scripts/build_cards.js
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

/** EDIT if you ever change repo */
const REPO_SLUG = 'Jrosai-dev/fundlibraries-campaigns';
const CDN_BASE  = `https://cdn.jsdelivr.net/gh/${REPO_SLUG}@main/public/`;

/** Your two web apps (force bypass of Apps Script cache) */
const CAMPAIGNS_URL = 'https://script.google.com/macros/s/AKfycbyiouHm4YRuReOn73FR_uLr7wJpBTW4QhCaXb9a12x3_wuYMll9FiBPj9lPQcOFhkAfRA/exec?nocache=1';
const UPDATES_URL   = 'https://script.google.com/macros/s/AKfycbw21MCIKLKDMUZmsDP0AAvnmsGwCN1TYHviqcUmArJDOW8y1LdpMFvFugXY4iWI4nUz4A/exec?nocache=1';

const OUT_DIR  = path.join(__dirname, '..', 'public');
const OUT_FILE = path.join(OUT_DIR, 'campaigns.cards.min.json'); // canonical aggregated for back compat

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

const cleanStr = v => {
  if (v == null) return '';
  const s = String(v).trim();
  const sl = s.toLowerCase();
  if (sl === 'undefined' || sl === 'null') return '';
  return s;
};
const numish = v => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$, ]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const splitLocation = loc => {
  if (!loc) return { city: '', state: '' };
  const parts = String(loc).split(',').map(s => s.trim());
  return { city: parts[0] || '', state: parts[1] || '' };
};
const parseDateAny = v => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
};
const fmtPretty = d =>
  new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(d);

/** Map a campaign to your card shape */
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

function isPublic(card) {
  return String(card.status || '').toLowerCase() === 'active';
}

/** Normalize updates and add pretty + iso dates */
function mapUpdate(u) {
  const slug = cleanStr(u.slug);
  const content = cleanStr(u.content);
  const rawDate = u.date != null ? u.date : u.updated_at;
  const d = parseDateAny(rawDate);
  const date_iso = d ? d.toISOString() : '';
  const date_pretty = d ? fmtPretty(d) : cleanStr(rawDate);
  return { slug, date: date_pretty, date_iso, content };
}

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
    // 1) Fetch both sources
    const [campaignsText, updatesText] = await Promise.all([
      fetchText(CAMPAIGNS_URL),
      fetchText(UPDATES_URL)
    ]);
    const campaignsRoot = parsePossiblyQuotedJSON(campaignsText);
    const updatesRoot   = parsePossiblyQuotedJSON(updatesText);

    // 2) Flexible shapes
    const rawCampaigns =
      Array.isArray(campaignsRoot?.front)     ? campaignsRoot.front :
      Array.isArray(campaignsRoot?.campaigns) ? campaignsRoot.campaigns :
      Array.isArray(campaignsRoot)            ? campaignsRoot :
      [];

    const rawUpdates =
      Array.isArray(updatesRoot?.updates) ? updatesRoot.updates :
      Array.isArray(updatesRoot)          ? updatesRoot :
      [];

    // 3) Normalize
    const baseCards = rawCampaigns.map(mapCampaign).filter(isPublic);
    const updates   = rawUpdates.map(mapUpdate);
    const bySlug    = groupUpdatesBySlug(updates);

    // 4) Merge updates, bump updated_at with newest update
    const cards = baseCards.map(card => {
      const ups = bySlug.get(card.slug) || [];
      if (ups.length && ups[0].date_iso) card.updated_at = ups[0].date_iso;
      return { ...card, updates: ups };
    });

    // 5) Sort cards by updated_at desc
    cards.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

    // 6) Ensure out dir
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    // 7) Canonical aggregated (back compat)
    fs.writeFileSync(OUT_FILE, JSON.stringify(cards), 'utf8');

    // 8) Build small index and homepage lists from cards
    const index = cards.map(c => ({
      slug: c.slug,
      title: c.title,
      short: c.short || '',
      description: c.description || '',     // include for Explore
      organization: c.organization || '',   // include for Explore
      img: c.img,
      goal: c.goal,
      raised: c.raised,
      category: c.category,
      city: c.city,
      state: c.state,
      updated_at: c.updated_at
    }));

    const homeTop = [...cards]
      .sort((a, b) => (b.raised || 0) - (a.raised || 0))
      .slice(0, 6)
      .map(c => ({
        slug: c.slug,
        title: c.title,
        short: c.short || '',
        organization: c.organization || '',
        img: c.img,
        goal: c.goal,
        raised: c.raised,
        category: c.category,
        city: c.city,
        state: c.state,
        updated_at: c.updated_at
      }));

    // 9) Versioned names
    const stamp = utcStamp();
    const hash  = crypto.createHash('sha1').update(JSON.stringify(cards)).digest('hex').slice(0, 8);

    const cardsName = `campaigns.cards.${stamp}.${hash}.min.json`;
    const indexName = `campaigns.index.${stamp}.${hash}.min.json`;
    const homeName  = `campaigns.home.${stamp}.${hash}.min.json`;

    // 10) Write versioned aggregated, index, home
    fs.writeFileSync(path.join(OUT_DIR, cardsName), JSON.stringify(cards), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, indexName), JSON.stringify(index), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, homeName),  JSON.stringify(homeTop), 'utf8');

    // Optional non-versioned copies for people hitting them directly
    fs.writeFileSync(path.join(OUT_DIR, 'campaigns.index.min.json'), JSON.stringify(index), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'campaigns.home.min.json'),  JSON.stringify(homeTop), 'utf8');

    // 11) Per-slug files in a versioned folder
    const perSlugDirName = `campaigns.v-${stamp}.${hash}`;
    const perSlugDir     = path.join(OUT_DIR, perSlugDirName);
    if (!fs.existsSync(perSlugDir)) fs.mkdirSync(perSlugDir);
    for (const c of cards) {
      if (!c.slug) continue;
      fs.writeFileSync(path.join(perSlugDir, `${c.slug}.json`), JSON.stringify(c), 'utf8');
    }

    // 12) Manifest for back compat
    const manifest = {
      base: CDN_BASE + perSlugDirName + '/',
      stamp,
      hash,
      count: cards.length,
      slugs: cards.map(c => c.slug)
    };
    fs.writeFileSync(path.join(OUT_DIR, 'campaigns.manifest.json'), JSON.stringify(manifest), 'utf8');

    // 13) Pointer to current versioned aggregated file
    const latest = {
      url: CDN_BASE + cardsName,
      stamp,
      hash,
      updated_at: new Date().toISOString(),
      count: cards.length
    };
    fs.writeFileSync(path.join(OUT_DIR, 'cards.latest.json'), JSON.stringify(latest), 'utf8');

    // 14) Single pointer with only versioned URLs that pages should read first
    const feeds = {
      per_slug_base: CDN_BASE + perSlugDirName + '/',
      index_url:     CDN_BASE + indexName,
      home_url:      CDN_BASE + homeName,
      cards_url:     CDN_BASE + cardsName
    };
    fs.writeFileSync(path.join(OUT_DIR, 'feeds.latest.json'), JSON.stringify(feeds), 'utf8');

    console.log('Wrote:');
    console.log('  canonical:', OUT_FILE);
    console.log('  versioned:', path.join(OUT_DIR, cardsName));
    console.log('  index:',     path.join(OUT_DIR, indexName));
    console.log('  home:',      path.join(OUT_DIR, homeName));
    console.log('  per-slug:',  path.join(perSlugDir, '<slug>.json'));
    console.log('  manifest:',  path.join(OUT_DIR, 'campaigns.manifest.json'));
    console.log('  cards ptr:', path.join(OUT_DIR, 'cards.latest.json'));
    console.log('  feeds ptr:', path.join(OUT_DIR, 'feeds.latest.json'));
  } catch (err) {
    console.error('Build failed:', err.stack || err.message);
    process.exit(1);
  }
})();

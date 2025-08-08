const https = require('https');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://script.google.com/macros/s/AKfycbz45NPJ1q8tG6at1qCVmoNTOk53cFhKlJNCq-tqw6W1h2bQDwbyipW0CAyrJ89c7ZSk/exec';
const OUT_DIR = path.join(__dirname, '..', 'public');
const OUT_FILE = path.join(OUT_DIR, 'campaigns.cards.min.json');

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
  // Try normal parse first
  try { return JSON.parse(text); } catch (_) {}
  // If it looks like " {...} " without escaping, strip outer quotes and try again
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"')) {
    const unwrapped = t.slice(1, -1);
    try { return JSON.parse(unwrapped); } catch (_) {}
    // If it was a properly escaped JSON string, parse twice
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

function mapOne(c) {
  const { city, state } = splitLocation(c.location);

  return {
    id: c.slug,
    slug: c.slug,
    title: c.title || 'Untitled',
    short: c.excerpt || '',
    img: c.featured_image || '',
    raised: Number(c.raised) || 0,
    goal: Number(c.funding_goal) || 0,

    // NEW / important for Explore filters
    category: c.category || '',
    location: c.location || [city, state].filter(Boolean).join(', '),
    city,
    state,

    organization: c.organization || '',
    status: c.status || '',

    // Dates (keep all so you can sort/filter later)
    start_date: c.start_date || '',
    end_date: c.end_date || '',
    created_at: c.created_at || '',
    updated_at: c.updated_at || c.end_date || c.created_at || ''
  };
}

function isPublic(c) {
  return String(c.status || '').toLowerCase() === 'active';
}

(async function main() {
  try {
    const text = await fetchText(SOURCE_URL);
    const root = parsePossiblyQuotedJSON(text);

    const campaigns = Array.isArray(root.campaigns) ? root.campaigns : [];
    const cards = campaigns.filter(isPublic).map(mapOne);
    cards.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(cards), 'utf8');
    console.log('Wrote', OUT_FILE, 'items:', cards.length);
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
  }
})();

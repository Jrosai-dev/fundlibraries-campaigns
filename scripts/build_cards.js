const https = require('https');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://script.google.com/macros/s/AKfycbz45NPJ1q8tG6at1qCVmoNTOk53cFhKlJNCq-tqw6W1h2bQDwbyipW0CAyrJ89c7ZSk/exec';
const OUT_DIR = path.join(__dirname, '..', 'public');
const OUT_FILE = path.join(OUT_DIR, 'campaigns.cards.min.json');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function splitLocation(loc) {
  if (!loc) return { city: '', state: '' };
  const parts = String(loc).split(',').map(s => s.trim());
  if (parts.length >= 2) return { city: parts[0], state: parts[1] };
  return { city: loc, state: '' };
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
    city,
    state,
    updated_at: c.created_at || c.end_date || '',
    status: c.status || '',
    organization: c.organization || ''
  };
}

function isPublic(c) {
  if (!c) return false;
  if (String(c.status || '').toLowerCase() !== 'active') return false;
  return true;
}

(async function main(){
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const raw = await fetchJSON(SOURCE_URL);
  const list = Array.isArray(raw.campaigns) ? raw.campaigns : [];
  const cards = list.filter(isPublic).map(mapOne);
  // newest first by updated_at if present
  cards.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  fs.writeFileSync(OUT_FILE, JSON.stringify(cards), 'utf8');
  console.log('Wrote', OUT_FILE, 'items:', cards.length);
})();

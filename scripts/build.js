// Build RSS from BLM keyword search (renders client-side)
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const ROOT = process.cwd();
const CFG_PATH = path.join(ROOT, 'feeds', 'queries.json');
const OUT_DIR = path.join(ROOT, 'docs');
const OUT_MAIN = path.join(OUT_DIR, 'index.xml');
const OUT_STATE_DIR = path.join(OUT_DIR, 'by-state');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowRfc822() { return new Date().toUTCString(); }
function escapeXml(s='') {
  return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
}

function itemToRss(item) {
  const descParts = [];
  if (item.state) descParts.push(`<b>State:</b> ${escapeXml(item.state)}`);
  if (item.office) descParts.push(`<b>Office:</b> ${escapeXml(item.office)}`);
  if (item.nepaType) descParts.push(`<b>Doc:</b> ${escapeXml(item.nepaType)}`);
  if (item.nepaStatus) descParts.push(`<b>Status:</b> ${escapeXml(item.nepaStatus)}`);
  const description = descParts.length ? `<p>${descParts.join('<br/>')}</p>` : '';
  return `
  <item>
    <guid isPermaLink="false">${escapeXml(item.id)}</guid>
    <title>${escapeXml(item.title)}</title>
    <link>${escapeXml(item.url)}</link>
    <pubDate>${nowRfc822()}</pubDate>
    <description><![CDATA[${description}]]></description>
  </item>`;
}

function writeRss(filePath, title, link, items) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${escapeXml(title)}</title>
  <link>${escapeXml(link)}</link>
  <description>${escapeXml(title)}</description>
  <lastBuildDate>${nowRfc822()}</lastBuildDate>
  ${items.map(itemToRss).join('\n')}
</channel>
</rss>`;
  fs.writeFileSync(filePath, xml.trim() + '\n', 'utf8');
}

// Scrape a rendered results page for anchors like /eplanning-ui/project/<id>/510
async function scrapeSearchTerm(page, term) {
  const url = 'https://eplanning.blm.gov/eplanning-ui/search?searchText=' + encodeURIComponent(term);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // If there is a Search button, click it; some builds require it to fire XHR
  try {
    await page.waitForSelector('button:has-text("Search"), [role="button"][aria-label*="Search"]', { timeout: 3000 });
    await page.click('button:has-text("Search"), [role="button"][aria-label*="Search"]');
  } catch (_) {}

  // Wait for any project link to appear (up to 15s)
  await page.waitForFunction(() => {
    return !!document.querySelector('a[href^="/eplanning-ui/project/"][href$="/510"]');
  }, { timeout: 15000 }).catch(() => {});

  // Grab links and titles
  const items = await page.$$eval('a[href^="/eplanning-ui/project/"][href$="/510"]', as =>
    as.map(a => ({
      url: new URL(a.getAttribute('href'), 'https://eplanning.blm.gov').toString(),
      title: (a.textContent || '').trim()
    }))
  );

  // Map to our shape with ID extracted
  const mapped = items.map(({ url, title }) => {
    const m = url.match(/\/project\/(\d+)\/510/);
    const id = m ? m[1] : undefined;
    return id ? { id, title: title || `BLM Project ${id}`, url } : null;
  }).filter(Boolean);

  return mapped;
}

async function run() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const states = Array.isArray(cfg.states) ? cfg.states : [];
  const queries = Array.isArray(cfg.queries) ? cfg.queries : [];

  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('overlook-blm-rss (+https://github.com/treillycodes/overlook-blm-rss)');

  const merged = [];
  const seen = new Set();

  for (const q of queries) {
    if (!q || !q.searchText) continue;

    const terms = [];
    if (q.perState && states.length) {
      for (const st of states) terms.push(`${q.searchText} ${st}`.trim());
    } else {
      terms.push(q.searchText);
    }

    for (const term of terms) {
      const rows = await scrapeSearchTerm(page, term);
      for (const r of rows) {
        const key = `${r.id}|${r.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...r });
      }
    }
  }

  await browser.close();

  // Write master feed
  ensureDir(OUT_DIR);
  writeRss(
    OUT_MAIN,
    'The Overlook — BLM Keyword Watch (National)',
    'https://eplanning.blm.gov/eplanning-ui/home',
    merged
  );

  // Optional per-state feeds (we don’t get state reliably via keyword scrape, so skip unless you later enrich)
  fs.writeFileSync(path.join(OUT_DIR, 'last-run.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total: merged.length }, null, 2));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

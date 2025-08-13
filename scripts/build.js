// Build RSS from BLM keyword search (searchText) endpoint
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CFG_PATH = path.join(ROOT, 'feeds', 'queries.json');
const OUT_DIR = path.join(ROOT, 'docs');
const OUT_MAIN = path.join(OUT_DIR, 'index.xml');
const OUT_STATE_DIR = path.join(OUT_DIR, 'by-state');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowRfc822() { return new Date().toUTCString(); }
function escapeXml(s='') {
  return s.replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c]));
}

function normalizeRows(data) {
  const rows = Array.isArray(data) ? data
    : Array.isArray(data.items) ? data.items
    : Array.isArray(data.content) ? data.content
    : Array.isArray(data.results) ? data.results
    : Array.isArray(data.data) ? data.data
    : [];

  return rows.map(p => {
    const id = String(p.id ?? p.projectId ?? p.nepaId ?? p.documentId ?? p.projectID ?? p.nepaNumber ?? '').trim();
    const title = (p.projectName ?? p.title ?? p.name ?? `BLM Project ${id}`).toString().trim();
    const states = p.state ? [p.state] : (Array.isArray(p.states) ? p.states : []);
    const state = states.filter(Boolean).join(', ') || undefined;
    const office = p.leadOfficeName ?? p.office ?? p.fieldOffice ?? undefined;
    const nepaStatus = p.nepaStatus ?? p.nepaStage ?? p.status ?? undefined;
    const nepaType = p.nepaDocType ?? p.type ?? undefined;
    const url =
      p.url ??
      (p.projectId ? `https://eplanning.blm.gov/eplanning-ui/project/${p.projectId}/510`
                   : (id ? `https://eplanning.blm.gov/eplanning-ui/project/${id}/510` : undefined));

    return { id, title, url, state, office, nepaStatus, nepaType, raw: p };
  }).filter(x => x.id && x.url);
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

async function fetchKeyword(searchText, page = 0, size = 100) {
  const endpoint = 'https://eplanning.blm.gov/eplanning-ui/search';

  // Try the JSON API first (some environments honor this)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/plain, */*',
      'user-agent': 'overlook-blm-rss (+https://github.com/treillycodes/overlook-blm-rss)',
      'x-requested-with': 'XMLHttpRequest',
      'origin': 'https://eplanning.blm.gov',
      'referer': 'https://eplanning.blm.gov/eplanning-ui/home'
    },
    body: JSON.stringify({ searchText, page, size }),
  });

  const ct = (res.headers.get('content-type') || '').toLowerCase();

  // If we actually got JSON, use it
  if (ct.includes('application/json')) {
    const data = await res.json();
    return normalizeRows(data);
  }

  // Fallback: fetch the HTML search page and parse links
  return await fetchKeywordViaHtml(searchText);
}

async function fetchKeywordViaHtml(searchText) {
  // Build the same page the UI shows when you type in the box
  const url = 'https://eplanning.blm.gov/eplanning-ui/search?searchText=' + encodeURIComponent(searchText);

  const htmlRes = await fetch(url, {
    headers: {
      'user-agent': 'overlook-blm-rss (+https://github.com/treillycodes/overlook-blm-rss)',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const html = await htmlRes.text();

  // Parse project links like: href="/eplanning-ui/project/1234567/510">Project Title</a>
  const items = [];
  const linkRe = /href="(\/eplanning-ui\/project\/(\d+)\/510)"[^>]*>([^<]+)<\/a>/gi;

  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const rel = m[1];
    const id  = m[2];
    const title = m[3].trim();
    const abs = 'https://eplanning.blm.gov' + rel;

    items.push({
      id,
      title: title || `BLM Project ${id}`,
      url: abs,
      // State/office/status aren’t reliably present without extra requests;
      // we keep them empty in fallback. RSS still works for posting to Discord.
      state: undefined,
      office: undefined,
      nepaStatus: undefined,
      nepaType: undefined,
    });
  }

  return items;
}


async function run() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  const states = Array.isArray(cfg.states) ? cfg.states : [];
  const queries = Array.isArray(cfg.queries) ? cfg.queries : [];

  const merged = [];
  const seen = new Set();

  // For each query, run once per state (if perState), otherwise national once
  for (const q of queries) {
    if (!q || !q.searchText) continue;

    if (q.perState && states.length) {
      for (const st of states) {
        const term = `${q.searchText} ${st}`.trim();
        const rows = await fetchKeyword(term);
        for (const r of rows) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          merged.push(r);
        }
      }
    } else {
      const rows = await fetchKeyword(q.searchText);
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        merged.push(r);
      }
    }
  }

  // Output master feed
  ensureDir(OUT_DIR);
  writeRss(
    OUT_MAIN,
    'The Overlook — BLM Keyword Watch (National)',
    'https://eplanning.blm.gov/eplanning-ui/home',
    merged
  );

  // Optional per-state feeds (based on item state metadata, if present)
  const byState = new Map();
  for (const r of merged) {
    const states = (r.state || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!states.length) continue;
    for (const st of states) {
      if (!byState.has(st)) byState.set(st, []);
      byState.get(st).push(r);
    }
  }

  if (byState.size) {
    ensureDir(OUT_STATE_DIR);
    for (const [st, items] of byState.entries()) {
      const fname = st.toUpperCase().replace(/[^A-Z]/g, '');
      const fpath = path.join(OUT_STATE_DIR, `${fname}.xml`);
      writeRss(
        fpath,
        `The Overlook — BLM Keyword Watch (${st})`,
        'https://eplanning.blm.gov/eplanning-ui/home',
        items
      );
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'last-run.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total: merged.length }, null, 2));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

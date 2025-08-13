// Build RSS from BLM NEPA search API
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SEARCHES_PATH = path.join(ROOT, 'feeds', 'searches.json');
const OUT_DIR = path.join(ROOT, 'docs');
const OUT_MAIN = path.join(OUT_DIR, 'index.xml');          // master feed
const OUT_STATE_DIR = path.join(OUT_DIR, 'by-state');       // optional per-state feeds

// ---- helpers ---------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function parseAdvFromUrl(u) {
  try {
    const url = new URL(u);
    const raw = url.searchParams.get('advSearch');
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function normalizeRows(data) {
  const rows = Array.isArray(data) ? data
    : Array.isArray(data.items) ? data.items
    : Array.isArray(data.content) ? data.content
    : Array.isArray(data.results) ? data.results
    : Array.isArray(data.data) ? data.data
    : [];
  return rows.map(p => {
    const id = String(
      p.id ?? p.projectId ?? p.nepaId ?? p.documentId ?? p.projectID ?? p.nepaNumber ?? ''
    ).trim();
    const title = (p.projectName ?? p.title ?? p.name ?? `BLM Project ${id}`).toString().trim();
    const states = p.state
      ? [p.state]
      : Array.isArray(p.states) ? p.states : [];
    const state = states.filter(Boolean).join(', ') || undefined;
    const office = p.leadOfficeName ?? p.office ?? p.fieldOffice ?? undefined;
    const nepaStatus = p.nepaStatus ?? p.nepaStage ?? p.status ?? undefined;
    const nepaType = p.nepaDocType ?? p.type ?? undefined;
    const url =
      p.url ??
      (p.projectId ? `https://eplanning.blm.gov/eplanning-ui/project/${p.projectId}/510`
                   : id ? `https://eplanning.blm.gov/eplanning-ui/project/${id}/510`
                        : undefined);
    return { id, title, url, state, office, nepaStatus, nepaType, raw: p };
  }).filter(x => x.id && x.url);
}

function escapeXml(s='') {
  return s.replace(/[<>&'"]/g, c => ({
    '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'
  }[c]));
}

function nowRfc822() {
  return new Date().toUTCString();
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

// ---- main ------------------------------------------------------------------

async function run() {
  const searches = JSON.parse(fs.readFileSync(SEARCHES_PATH, 'utf8'));

  const endpoint = 'https://eplanning.blm.gov/eplanning-ui/search';
  const merged = [];
  const seen = new Set();

  for (const s of searches) {
    const adv = s.advSearch || parseAdvFromUrl(s.url || s.link || s.href);
    if (!adv) continue;

    // One page of up to 100 results per search. Duplicate the call with page:1 if needed later.
    const body = JSON.stringify({ advSearch: adv, page: 0, size: 100 });

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/plain, */*'
      },
      body
    });

    if (!res.ok) {
      console.error(`HTTP ${res.status} for search "${s.name || 'unnamed'}"`);
      continue;
    }

    const data = await res.json();
    const rows = normalizeRows(data);

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
  }

  // Output master feed
  ensureDir(OUT_DIR);
  writeRss(
    OUT_MAIN,
    'The Overlook — BLM Lands & Realty Watch (National)',
    'https://eplanning.blm.gov/eplanning-ui/home',
    merged
  );

  // Optional per-state feeds
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
        `The Overlook — BLM Watch (${st})`,
        'https://eplanning.blm.gov/eplanning-ui/home',
        items
      );
    }
  }

  // Simple marker for debugging
  fs.writeFileSync(path.join(OUT_DIR, 'last-run.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total: merged.length }, null, 2));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

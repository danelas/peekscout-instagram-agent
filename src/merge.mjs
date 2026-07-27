#!/usr/bin/env node
// Merge every contact CSV that run.mjs has produced into one deduped master list.
// The same business shows up across runs, across hashtags, and under multiple IG
// accounts (two handles -> one shared email), so we collapse on the contact itself:
// by email when there is one, else by phone. Handles/sources are unioned so you keep
// the provenance.
//
//   node merge.mjs                       # merge ./out/*.csv -> ./out/master-<ts>.csv
//   node merge.mjs --dir some/other/out  # merge a different folder
//   node merge.mjs --out leads.csv       # explicit output path
//
// Only reads CSVs that look like run.mjs output (a header containing an `email`
// column); discovery CSVs (handles/locations) are skipped automatically.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const dir = arg('dir', join(here, 'out'));

// Same placeholder/infra filter run.mjs uses — re-applied here so older CSVs
// (generated before the filter existed) don't leak junk into the master list.
const PLACEHOLDER =
  /(example\.(com|org|net)|yourdomain|your-domain|yoursite|domain\.com|email\.com|company\.com|acme|test@|no-?reply|do-?not-?reply|donotreply|postmaster@|abuse@|webmaster@|hostmaster@|@sentry|wixpress|@wix\.com|@squarespace|@godaddy|@shopify|sentry\.io|u00[0-9a-f]{2}|xn--|user@domain|you@|name@example|firstname|lastname)/i;
// Booking / e-comm / SaaS platform support addresses scraped from site footers —
// not the provider's own contact. Full-domain match (handles subdomains + w.app).
const PLATFORM =
  /@([a-z0-9-]+\.)*(vagaro\.com|booksy\.com|mindbody(online)?\.com|glossgenius\.com|fresha\.com|styleseat\.com|squareup\.com|square\.site|acuityscheduling\.com|schedulicity\.com|setmore\.com|gettimely\.com|timely\.com|phorest\.com|blvd\.co|joinblvd\.com|zenoti\.com|calendly\.com|mystore\.com|hellofresh\.com|w\.app|callbamba\.com|typemade\.mx|goldie\.app|getgoldie\.com|wixsite\.com|shopify\.com|myshopify\.com|godaddysites\.com|weebly\.com|bookingkoala\.com|noterro\.com|janeapp\.com|simplybook\.me)$/i;

// --- tiny CSV parser (handles quoted fields + escaped "") -------------------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --- gather run.mjs contact CSVs -------------------------------------------
let files;
try {
  files = (await readdir(dir)).filter((f) => f.endsWith('.csv') && !f.startsWith('master') && !f.startsWith('discovered'));
} catch {
  console.error(`Cannot read directory: ${dir}`);
  process.exit(1);
}

// --- merge ------------------------------------------------------------------
// key -> record. Prefer email as the identity; fall back to phone; skip if neither.
const byEmail = new Map();
const byPhone = new Map();
let rowsRead = 0;

const uniq = (arr) => [...new Set(arr.filter(Boolean))];

for (const file of files.sort()) {
  const rows = parseCSV(await readFile(join(dir, file), 'utf8'));
  if (!rows.length) continue;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  if (idx('email') === -1) continue; // not a run.mjs contact CSV

  for (const cols of rows.slice(1)) {
    const get = (name) => (idx(name) === -1 ? '' : (cols[idx(name)] ?? '').trim());
    let email = get('email').toLowerCase();
    if (email && (PLACEHOLDER.test(email) || PLATFORM.test(email))) email = ''; // scrub junk / platform addrs
    const phone = get('phone');
    if (!email && !phone) continue;
    rowsRead++;

    const incoming = {
      email,
      phone,
      usernames: uniq([get('username')]),
      fullName: get('fullname'),
      category: get('category'),
      followers: get('followers'),
      sources: uniq([get('source')]),
      files: uniq([file]),
    };

    // find an existing record to merge into (by email first, then phone)
    let rec = (email && byEmail.get(email)) || (phone && byPhone.get(phone)) || null;
    if (!rec) {
      rec = incoming;
    } else {
      rec.email ||= incoming.email;
      rec.phone ||= incoming.phone;
      rec.fullName ||= incoming.fullName;
      rec.category ||= incoming.category;
      rec.followers ||= incoming.followers;
      rec.usernames = uniq([...rec.usernames, ...incoming.usernames]);
      rec.sources = uniq([...rec.sources, ...incoming.sources]);
      rec.files = uniq([...rec.files, ...incoming.files]);
    }
    // (re)index under whatever identifiers this record now has
    if (rec.email) byEmail.set(rec.email, rec);
    if (rec.phone) byPhone.set(rec.phone, rec);
  }
}

// A record indexed under both email and phone appears in both maps — dedupe by identity.
const master = uniq([...byEmail.values(), ...byPhone.values()].map((r) => r)).filter(
  (r, i, a) => a.indexOf(r) === i,
);

// stable, useful ordering: emailed leads first, then by follower count desc
master.sort((a, b) => {
  if (!!b.email - !!a.email) return !!b.email - !!a.email;
  return (Number(b.followers) || 0) - (Number(a.followers) || 0);
});

// --- write master -----------------------------------------------------------
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const out = [['email', 'phone', 'usernames', 'fullName', 'category', 'followers', 'sources', 'seen_in_files'].join(',')];
for (const r of master) {
  out.push(
    [r.email, r.phone, r.usernames.join(' '), r.fullName, r.category, r.followers, r.sources.join(' '), r.files.length]
      .map(esc)
      .join(','),
  );
}

const outPath = arg('out', join(dir, `master-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`));
await writeFile(outPath, out.join('\n'));

// --- summary ----------------------------------------------------------------
const withEmail = master.filter((r) => r.email).length;
const withPhone = master.filter((r) => r.phone).length;
const collapsed = rowsRead - master.length;
console.log(`Merged ${files.length} CSV file(s), ${rowsRead} contact rows`);
console.log(`  -> ${master.length} unique leads (${collapsed} duplicate row(s) collapsed)`);
console.log(`     ${withEmail} with email, ${withPhone} with phone`);
console.log(`  master -> ${outPath}`);
const multi = master.filter((r) => r.usernames.length > 1);
if (multi.length) {
  console.log(`\n  ${multi.length} lead(s) merged from multiple handles, e.g.:`);
  for (const r of multi.slice(0, 5)) console.log(`    ${r.email || r.phone}  <-  @${r.usernames.join(', @')}`);
}

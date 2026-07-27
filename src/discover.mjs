#!/usr/bin/env node
// Discover Instagram handles from hashtags, then (optionally) pipe them straight
// into run.mjs to pull emails + phones. This is the list-builder front-end:
// a city + a service hashtag -> hundreds of provider handles -> contacts.
//
//   APIFY_TOKEN=... node discover.mjs --tags miamimassage,miamilashtech --limit 100
//   APIFY_TOKEN=... node discover.mjs --tags miamicleaning --limit 200 --run
//
// Writes ./out/handles-<timestamp>.txt (one handle per line, feeds run.mjs)
// and ./out/discovered-<timestamp>.csv (handle,fullName,location,tag,posts).
// With --run, chains into run.mjs on the discovered handles automatically.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ACTOR = 'apify~instagram-hashtag-scraper';
const TOKEN = process.env.APIFY_TOKEN;
const here = dirname(fileURLToPath(import.meta.url));

if (!TOKEN) {
  console.error('APIFY_TOKEN is not set. Get it at https://console.apify.com/settings/integrations');
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const tags = (arg('tags', '') || '')
  .split(',')
  .map((t) => t.trim().replace(/^#/, ''))
  .filter(Boolean);

if (!tags.length) {
  console.error('No hashtags. Pass --tags miamimassage,miamilashtech');
  process.exit(1);
}

const limit = Number(arg('limit', 100)); // posts scanned per hashtag
const minFollowFilter = has('business-only'); // keep only accounts that look like a business

// --- run the hashtag actor -------------------------------------------------
const input = { hashtags: tags, resultsType: 'posts', resultsLimit: limit };

console.log(`Discovering handles from #${tags.join(', #')} (up to ${limit} posts each) ...`);
const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${TOKEN}`;
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(input),
});

if (!res.ok) {
  console.error(`\nHTTP ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const posts = await res.json();

// --- dedupe to unique accounts, keep the richest context we saw -------------
const accounts = new Map(); // username -> { username, fullName, location, tag, posts }
for (const p of posts) {
  const username = p.ownerUsername;
  if (!username) continue;
  const prev = accounts.get(username);
  if (prev) {
    prev.posts += 1;
    prev.fullName ||= p.ownerFullName || '';
    prev.location ||= p.locationName || '';
  } else {
    accounts.set(username, {
      username,
      fullName: p.ownerFullName || '',
      location: p.locationName || '',
      tag: (p.hashtags && p.hashtags[0]) || tags[0],
      posts: 1,
    });
  }
}

let list = [...accounts.values()].sort((a, b) => b.posts - a.posts);

// Optional coarse filter: drop obvious personal accounts (no full name AND single post).
if (minFollowFilter) {
  list = list.filter((a) => a.fullName || a.posts > 1);
}

// --- write outputs ---------------------------------------------------------
const outDir = join(here, 'out');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const handlesFile = join(outDir, `handles-${stamp}.txt`);
const csvFile = join(outDir, `discovered-${stamp}.csv`);

await writeFile(handlesFile, list.map((a) => a.username).join('\n') + '\n');

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const rows = [['username', 'fullName', 'location', 'tag', 'posts'].join(',')];
for (const a of list) rows.push([a.username, a.fullName, a.location, a.tag, a.posts].map(esc).join(','));
await writeFile(csvFile, rows.join('\n'));

console.log(`\n${posts.length} posts -> ${list.length} unique handles`);
console.log(`  handles -> ${handlesFile}`);
console.log(`  CSV     -> ${csvFile}\n`);
for (const a of list.slice(0, 12)) {
  console.log(`  ${String('@' + a.username).padEnd(28)} ${String(a.fullName).slice(0, 30).padEnd(32)} ${a.location || ''}`);
}
if (list.length > 12) console.log(`  ... ${list.length - 12} more`);

// --- optional: chain into run.mjs on the discovered handles ----------------
if (has('run')) {
  if (!list.length) {
    console.log('\nNothing to extract — skipping --run.');
    process.exit(0);
  }
  console.log(`\nChaining into run.mjs on ${list.length} handles ...\n`);
  const child = spawn(process.execPath, [join(here, 'run.mjs'), '--file', handlesFile], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.log(`\nNext: node run.mjs --file "${handlesFile}"`);
}

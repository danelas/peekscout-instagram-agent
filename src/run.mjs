#!/usr/bin/env node
// Pull emails out of Instagram profiles via the apify/instagram-profile-scraper.
//
// The profile scraper does NOT return the business "Email" contact button, but it
// DOES return `biography` + `externalUrls`. A lot of local-service accounts paste
// their email straight into the bio, so we regex it back out for free instead of
// renting a dedicated (ToS-gray, unreliable) email-extractor actor.
//
//   APIFY_TOKEN=... node run.mjs --users acme.plumbing,miami.hvac
//   APIFY_TOKEN=... node run.mjs --file usernames.txt --max 200
//
// Writes ./out/<timestamp>.json (full records) and ./out/<timestamp>.csv
// (username,email,source) and prints a hit-rate summary.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTOR = 'apify~instagram-profile-scraper';
const TOKEN = process.env.APIFY_TOKEN;

if (!TOKEN) {
  console.error('APIFY_TOKEN is not set. Get it at https://console.apify.com/settings/integrations');
  process.exit(1);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

// --- gather usernames ------------------------------------------------------
let usernames = [];
const usersArg = arg('users', '');
const fileArg = arg('file', '');
if (usersArg) usernames.push(...usersArg.split(','));
if (fileArg) {
  const text = await readFile(fileArg, 'utf8');
  usernames.push(...text.split(/[\r\n,]+/));
}
// normalise: strip @, urls, whitespace, blanks, dupes
usernames = [
  ...new Set(
    usernames
      .map((u) => u.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, ''))
      .filter(Boolean),
  ),
];

if (!usernames.length) {
  console.error('No usernames. Pass --users a,b,c or --file usernames.txt');
  process.exit(1);
}

const max = Number(arg('max', usernames.length));
usernames = usernames.slice(0, max);

// --- email extraction ------------------------------------------------------
// Deliberately conservative: real emails, not @handles or version strings.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Common junk that matches the shape but isn't a real contact address.
const JUNK = /\.(png|jpe?g|gif|webp|svg|mp4|pdf|css|js|json|woff2?|ico)$/i;
// Placeholder / template / infrastructure addresses that show up in site markup
// but are never a real provider contact — drop them so the list stays clean.
const PLACEHOLDER =
  /(example\.(com|org|net)|yourdomain|your-domain|yoursite|domain\.com|email\.com|company\.com|acme|test@|no-?reply|do-?not-?reply|donotreply|postmaster@|abuse@|webmaster@|hostmaster@|@sentry|wixpress|@wix\.com|@squarespace|@godaddy|@shopify|sentry\.io|\.png@|@2x|@sentry\.wixpress|u00[0-9a-f]{2}|xn--|^[a-f0-9]{16,}@|user@domain|you@|name@example|firstname|lastname)/i;
// Third-party booking / e-comm / SaaS platforms whose support addresses get
// scraped from a site's footer or scripts. These are NOT the provider's contact
// — emailing them is wrong. Full-domain match (handles subdomains + w.app).
const PLATFORM =
  /@([a-z0-9-]+\.)*(vagaro\.com|booksy\.com|mindbody(online)?\.com|glossgenius\.com|fresha\.com|styleseat\.com|squareup\.com|square\.site|acuityscheduling\.com|schedulicity\.com|setmore\.com|gettimely\.com|timely\.com|phorest\.com|blvd\.co|joinblvd\.com|zenoti\.com|calendly\.com|mystore\.com|hellofresh\.com|w\.app|callbamba\.com|typemade\.mx|goldie\.app|getgoldie\.com|wixsite\.com|shopify\.com|myshopify\.com|godaddysites\.com|weebly\.com|bookingkoala\.com|noterro\.com|janeapp\.com|simplybook\.me)$/i;
// US phone numbers — small local providers almost always list one in the bio.
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
// Link-in-bio aggregators: not the real site, but they DO expose a mailto and/or
// an outbound link to the real site — so we crawl the page, then follow through.
const AGGREGATORS = /(linktr\.ee|lnk\.bio|beacons\.ai|linkin\.bio|link\.me|gls\.sr|bit\.ly|tinyurl|allmylinks|snipfeed|withkoji|msha\.ke|stan\.store|linkbio|tap\.bio|shor\.by|campsite\.bio|flowpage|solo\.to|hoo\.be)/i;
// Domains that are never the provider's own contact site — don't follow these out of an aggregator.
const SOCIAL = /(instagram\.com|facebook\.com|fb\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|youtu\.be|t\.me|wa\.me|whatsapp\.com|pinterest\.|snapchat\.com|threads\.net|apple\.com|google\.com|maps\.|goo\.gl|cash\.app|venmo\.com|paypal\.|cashapp)/i;

function emailsFrom(text) {
  if (!text) return [];
  const out = [];
  for (const m of String(text).matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase().replace(/[.,;:)]+$/, ''); // trim trailing punctuation
    if (!JUNK.test(e) && !PLACEHOLDER.test(e) && !PLATFORM.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

function phonesFrom(text) {
  if (!text) return [];
  const out = [];
  for (const m of String(text).matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length === 10 || (digits.length === 11 && digits[0] === '1')) {
      const norm = digits.length === 11 ? digits.slice(1) : digits;
      const pretty = `(${norm.slice(0, 3)}) ${norm.slice(3, 6)}-${norm.slice(6)}`;
      if (!out.includes(pretty)) out.push(pretty);
    }
  }
  return out;
}

// Fetch one URL and pull emails (mailto: first, then raw text) out of the HTML.
async function scrapePage(href) {
  try {
    const r = await fetch(href, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; contact-finder/1.0)' },
    });
    if (!r.ok) return { emails: [], html: '' };
    const html = await r.text();
    const emails = [];
    for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
      for (const e of emailsFrom(decodeURIComponent(m[1]))) if (!emails.includes(e)) emails.push(e);
    }
    for (const e of emailsFrom(html)) if (!emails.includes(e)) emails.push(e);
    return { emails, html };
  } catch {
    return { emails: [], html: '' }; // timeout / DNS / TLS
  }
}

// CDN / font / analytics hosts that show up in aggregator markup but are never a lead.
const ASSET_HOST = /(cdn|fonts?|typekit|gstatic|googleapis|google-analytics|googletagmanager|cloudflare|jsdelivr|unpkg|fbcdn|cloudfront|amazonaws|schema\.org|w3\.org|doubleclick|sentry|hotjar)/i;

// From an aggregator page, pull the outbound links most likely to be the provider's
// own site. Aggregators (linktr.ee, lnk.bio) render destinations in JS/JSON, not in
// href attributes — so scan the raw HTML for full URLs, then dedupe by hostname.
function realSiteLinks(html, pageUrl) {
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname;
  } catch {
    /* ignore */
  }
  const seenHost = new Set();
  const out = [];
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
    let u;
    try {
      u = new URL(m[0]);
    } catch {
      continue;
    }
    const host = u.hostname;
    if (host === pageHost || seenHost.has(host)) continue;
    if (SOCIAL.test(host) || AGGREGATORS.test(host) || ASSET_HOST.test(host)) continue;
    seenHost.add(host);
    out.push(`${u.protocol}//${host}`); // crawl the site root, not the deep-linked path
  }
  return out.slice(0, 3); // cap follow-through
}

// Resolve emails from whatever the bio links to. Real site -> crawl contact pages.
// Aggregator -> scrape the hub itself, then follow its outbound links to the real site.
async function emailsFromSite(rawUrl) {
  let base;
  try {
    base = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return [];
  }

  if (AGGREGATORS.test(base.hostname)) {
    const hub = await scrapePage(base.href);
    if (hub.emails.length) return hub.emails; // mailto right on the linktree
    for (const link of realSiteLinks(hub.html, base.href)) {
      const found = await crawlRealSite(link);
      if (found.length) return found;
    }
    return [];
  }

  return crawlRealSite(base.href);
}

// A real business site: try homepage + the usual contact/about/booking paths.
async function crawlRealSite(rawUrl) {
  let base;
  try {
    base = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
  } catch {
    return [];
  }
  const paths = ['', 'contact', 'contact-us', 'about', 'book', 'booking'];
  const found = [];
  for (const p of paths) {
    const { emails } = await scrapePage(new URL(p, base).href);
    for (const e of emails) if (!found.includes(e)) found.push(e);
    if (found.length) break; // got one; don't hammer the rest of the paths
  }
  return found;
}

// Pull every candidate string a profile record exposes, tagged by where it came from.
function harvest(rec) {
  const found = [];
  const push = (source, text) => {
    for (const email of emailsFrom(text)) found.push({ email, source });
  };
  push('bio', rec.biography);
  // externalUrls: [{ url, title, lynx_url }] — a mailto: link is the cleanest signal.
  for (const ex of rec.externalUrls ?? []) {
    if (ex?.url) push('externalUrl', decodeURIComponent(ex.url).replace(/^mailto:/i, ''));
    if (ex?.title) push('externalUrl', ex.title);
  }
  if (rec.externalUrl) push('externalUrl', decodeURIComponent(rec.externalUrl).replace(/^mailto:/i, ''));
  // dedupe, prefer the first (bio) source for a given address
  const seen = new Set();
  return found.filter(({ email }) => (seen.has(email) ? false : seen.add(email)));
}

// --- run the actor ---------------------------------------------------------
const input = { usernames, resultsType: 'details' };

console.log(`Scraping ${usernames.length} profile(s) via ${ACTOR} ...`);
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

const records = await res.json();

const crawl = arg('no-crawl', null) === null; // site-crawl fallback on by default

// --- build results ---------------------------------------------------------
const results = [];
for (const rec of records) {
  const hits = harvest(rec);
  let emails = hits.map((h) => h.email);
  let emailSource = hits[0]?.source ?? null;

  // Fallback: no email in bio/links -> crawl the linked website for one.
  const siteUrl = rec.externalUrl || rec.externalUrls?.[0]?.url;
  if (!emails.length && crawl && siteUrl) {
    const siteEmails = await emailsFromSite(siteUrl);
    if (siteEmails.length) {
      emails = siteEmails;
      emailSource = 'website';
    }
  }

  results.push({
    username: rec.username ?? null,
    fullName: rec.fullName ?? null,
    isBusinessAccount: rec.isBusinessAccount ?? null,
    businessCategoryName: rec.businessCategoryName ?? null,
    followers: rec.followersCount ?? null,
    phones: phonesFrom(rec.biography),
    emails,
    emailSource,
    externalUrl: rec.externalUrl ?? null,
    biography: rec.biography ?? null,
  });
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonFile = join(outDir, `${stamp}.json`);
const csvFile = join(outDir, `${stamp}.csv`);

await writeFile(jsonFile, JSON.stringify(results, null, 2));

const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
// One row per provider — email/phone may be blank; a phone-only row is still a lead.
const rows = [['username', 'email', 'source', 'phone', 'fullName', 'category', 'followers'].join(',')];
for (const r of results) {
  if (!r.emails.length && !r.phones.length) continue;
  rows.push(
    [r.username, r.emails[0] ?? '', r.emailSource ?? '', r.phones[0] ?? '', r.fullName, r.businessCategoryName, r.followers]
      .map(esc)
      .join(','),
  );
}
await writeFile(csvFile, rows.join('\n'));

// --- summary ---------------------------------------------------------------
const withEmail = results.filter((r) => r.emails.length);
const withPhone = results.filter((r) => r.phones.length);
const rate = results.length ? Math.round((withEmail.length / results.length) * 100) : 0;
console.log(
  `\n${results.length} profile(s): ${withEmail.length} with email (${rate}%), ${withPhone.length} with phone`,
);
console.log(`  JSON -> ${jsonFile}`);
console.log(`  CSV  -> ${csvFile}\n`);
for (const r of results) {
  if (!r.emails.length && !r.phones.length) continue;
  const email = r.emails.length ? `${r.emails[0]} [${r.emailSource}]` : '(no email)';
  const phone = r.phones[0] ?? '';
  console.log(`  ${String('@' + r.username).padEnd(26)} ${email.padEnd(42)} ${phone}`);
}

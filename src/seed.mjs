#!/usr/bin/env node
// One-time (and top-up) importer: push a local master CSV of scraped leads into
// PeekScout's ig_outreach_leads via /api/outreach. Run this LOCALLY — the CSV
// holds email addresses and must never live in this public repo.
//
//   ADMIN_TOKEN=... node src/seed.mjs ../gold-touch-list/ig-email-extractor/out/master-XXXX.csv
//
// Idempotent: existing leads (and their SENT status) are left untouched.

import { readFile } from "node:fs/promises";

const API_BASE = (process.env.OUTREACH_API_BASE || "https://www.peekscout.com").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const file = process.argv[2];
if (!ADMIN_TOKEN) { console.error("ADMIN_TOKEN not set."); process.exit(1); }
if (!file) { console.error("Usage: node src/seed.mjs <path-to-master.csv>"); process.exit(1); }

// CSV parser matching the ig-email-extractor dialect (quoted, escaped "").
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (field !== "" || row.length) { row.push(field); rows.push(row); row = []; field = ""; }
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCSV(await readFile(file, "utf8"));
if (rows.length < 2) { console.error("Empty CSV."); process.exit(1); }
const header = rows[0].map((h) => h.trim().toLowerCase());
const col = (n) => header.indexOf(n);
if (col("email") === -1) { console.error("No email column — is this a master CSV?"); process.exit(1); }

const leads = rows.slice(1)
  .map((c) => ({
    email: (c[col("email")] ?? "").trim(),
    fullName: col("fullname") > -1 ? c[col("fullname")] : "",
    category: col("category") > -1 ? c[col("category")] : "",
    usernames: col("usernames") > -1 ? c[col("usernames")] : "",
    phone: col("phone") > -1 ? c[col("phone")] : "",
  }))
  .filter((l) => l.email);

console.log(`Importing ${leads.length} lead(s) from ${file} -> ${API_BASE} ...`);
const r = await fetch(`${API_BASE}/api/outreach`, {
  method: "POST",
  headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ import: leads }),
});
if (!r.ok) { console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exit(1); }
const out = await r.json();
console.log(`Done: ${out.imported ?? 0} new inserted (of ${out.importReceived ?? leads.length} received; duplicates skipped).`);

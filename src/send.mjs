#!/usr/bin/env node
// Daily ramped cold-outreach sender for PeekScout.
//
// Pulls the next batch of NEW leads from PeekScout's /api/outreach (which
// already excludes anyone on the suppression list), sends the first-touch pitch
// from the trypeekscout.com sending domain via Resend, and marks each lead
// SENT/FAILED so it's never emailed twice. Send-state lives in the DB, so this
// is safe to run in ephemeral CI.
//
//   node src/send.mjs --dry-run     # show who would send today, send nothing
//   node src/send.mjs               # send today's ramped batch
//
// Ramp: a brand-new sending domain must warm up. The daily cap grows with the
// weeks since the FIRST send (server tells us firstSentAt), so volume climbs on
// its own with zero date config.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Auto-load a local .env for local runs (CI passes env directly). .env is
// gitignored, so tokens never enter this public repo.
(function loadEnv() {
  const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const API_BASE = (process.env.OUTREACH_API_BASE || "https://www.peekscout.com").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.OUTREACH_FROM_EMAIL || "Peek Scout <hello@trypeekscout.com>";
const SITE_URL = (process.env.SITE_URL || "https://www.peekscout.com").replace(/\/$/, "");
const MAILING_ADDRESS = process.env.MAILING_ADDRESS;

// Weekly daily-cap ramp. Overridable via RAMP="10,20,30,50".
const RAMP = (process.env.RAMP || "15,25,40,50").split(",").map((n) => parseInt(n, 10)).filter((n) => n > 0);
const DELAY_MS = Number(process.env.SEND_DELAY_MS || 3000);

const flag = (n) => process.argv.includes(`--${n}`);
const dryRun = flag("dry-run");

const DAY = 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// trypeekscout.com only — never send cold mail from the primary domain.
const FROM_ADDR = (FROM.match(/<([^>]+)>/)?.[1] || FROM).trim();
if ((FROM_ADDR.split("@")[1] || "").toLowerCase() !== "trypeekscout.com") {
  console.error(`Refusing: cold outreach must send from trypeekscout.com, not "${FROM_ADDR}".`);
  process.exit(1);
}

// Skip weekends — cold email lands better Mon–Fri (cron is weekday-only too).
const dow = new Date().getUTCDay(); // 0 Sun .. 6 Sat
if ((dow === 0 || dow === 6) && !flag("force")) {
  console.log("Weekend — skipping. (Use --force to override.)");
  process.exit(0);
}

// ── email content ──────────────────────────────────────────────────────────
function firstName(email) {
  const local = email.split("@")[0];
  if (/^(info|contact|hello|hi|admin|support|booking|bookings|appointments|team|office|owner|sales|reception|hey|mail|inbox|studio|spa|salon|company)$/i.test(local)) {
    return "there";
  }
  const head = local.split(/[._\-]/)[0].replace(/\d+$/, "");
  if (head.length < 2 || head.length > 14 || /\d/.test(head)) return "there";
  return head.charAt(0).toUpperCase() + head.slice(1).toLowerCase();
}

function render(lead) {
  const first = firstName(lead.email);
  const cat = lead.category && lead.category.toLowerCase() !== "none" ? lead.category.toLowerCase() : "service";
  const signupUrl = `${SITE_URL}/pro?ref=outreach&email=${encodeURIComponent(lead.email)}`;
  const unsub = `${SITE_URL}/unsubscribe?email=${encodeURIComponent(lead.email)}`;
  const unsubApi = `${SITE_URL}/api/unsubscribe?email=${encodeURIComponent(lead.email)}`;
  const subject = "Free video profile on PeekScout";

  const text = [
    `Hey ${first},`,
    ``,
    `I'm with PeekScout — we help local ${cat} pros get discovered with short video profiles that customers browse and book from. We're featuring providers in your area right now and yours looks like a great fit.`,
    ``,
    `It's free to get listed. Booking leads come straight to you — you only pay when you want to unlock a paying customer.`,
    ``,
    `Claim your free profile (takes ~2 min):`,
    `${signupUrl}`,
    ``,
    `No worries if not your thing — just reply "no thanks" and I won't reach out again.`,
    ``,
    `— Dan, PeekScout`,
    `peekscout.com`,
    ``,
    `—`,
    `You're receiving this because your business is listed publicly. Unsubscribe: ${unsub}`,
    MAILING_ADDRESS || "",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:15px;color:#222;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
<p>Hey ${first},</p>
<p>I'm with <strong>PeekScout</strong> — we help local ${cat} pros get discovered with short video profiles that customers browse and book from. We're featuring providers in your area right now and yours looks like a great fit.</p>
<p>It's free to get listed. Booking leads come straight to you — you only pay when you want to unlock a paying customer.</p>
<p>Claim your free profile (takes ~2 min):<br><a href="${signupUrl}">${signupUrl}</a></p>
<p>No worries if not your thing — just reply "no thanks" and I won't reach out again.</p>
<p>— Dan, PeekScout<br><a href="https://peekscout.com">peekscout.com</a></p>
<hr style="border:none;border-top:1px solid #eee;margin:20px 0">
<p style="font-size:12px;color:#888">You're receiving this because your business is listed publicly. <a href="${unsub}">Unsubscribe</a>.<br>${MAILING_ADDRESS || ""}</p>
</body></html>`;

  return { subject, text, html, unsubApi };
}

async function sendViaResend(to, { subject, text, html, unsubApi }) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to,
      subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": `<${unsubApi}>, <mailto:${FROM_ADDR}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); } catch { return {}; }
}

// ── API helpers ──────────────────────────────────────────────────────────
async function api(path, init = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  if (!ADMIN_TOKEN) { console.error("ADMIN_TOKEN not set."); process.exit(1); }
  if (!dryRun && (!RESEND_API_KEY || !MAILING_ADDRESS)) {
    console.error(`Cannot send — missing ${!RESEND_API_KEY ? "RESEND_API_KEY " : ""}${!MAILING_ADDRESS ? "MAILING_ADDRESS" : ""}.`);
    process.exit(1);
  }

  const maxCap = Math.max(...RAMP);
  const data = await api(`/api/outreach?limit=${maxCap}`);

  // ramp cap from weeks since the first send
  const week = data.firstSentAt ? Math.floor((Date.now() - new Date(data.firstSentAt).getTime()) / (7 * DAY)) : 0;
  const cap = RAMP[Math.min(week, RAMP.length - 1)];
  const batch = (data.leads || []).slice(0, cap);

  console.log(`From: ${FROM}  ·  API: ${API_BASE}`);
  console.log(`Ramp week ${week} -> cap ${cap}/day · ${data.sentTotal} sent so far · ${batch.length} to send now`);
  console.log(`Mode: ${dryRun ? "DRY-RUN (nothing will send)" : "LIVE"}\n`);

  if (!batch.length) { console.log("No eligible leads today."); return; }

  const sent = [];
  const failed = [];
  for (let i = 0; i < batch.length; i++) {
    const lead = batch[i];
    console.log(`[${i + 1}/${batch.length}] -> ${lead.email}`);
    if (dryRun) continue;
    try {
      const { id } = await sendViaResend(lead.email, render(lead));
      sent.push({ email: lead.email, resendId: id });
      console.log(`     ok ${id ?? ""}`);
    } catch (e) {
      failed.push({ email: lead.email, error: e.message });
      console.log(`     FAIL ${e.message}`);
    }
    if (i < batch.length - 1) await sleep(DELAY_MS);
  }

  if (!dryRun && (sent.length || failed.length)) {
    await api(`/api/outreach`, { method: "POST", body: JSON.stringify({ mark: { sent, failed } }) });
  }
  console.log(`\n${dryRun ? "Dry-run" : "Done"}: ${sent.length} sent, ${failed.length} failed.`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });

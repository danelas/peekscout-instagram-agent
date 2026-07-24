# peekscout-instagram-agent

Daily **ramped cold-outreach sender** for PeekScout. Emails Instagram-scraped
local-service providers a first-touch pitch, warming up the sending domain
automatically and never double-sending or emailing anyone who opted out.

> **Public repo — no lead data lives here.** Email addresses (PII) are stored in
> PeekScout's database. This repo holds only code; it reaches leads through a
> token-guarded API. `.gitignore` blocks `*.csv`/`.env` so a lead file can't be
> committed by accident.

## How it works

1. **Leads live in Supabase** (`ig_outreach_leads`, via PeekScout's
   `/api/outreach`). You seed them once from your local master CSV.
2. **`src/send.mjs`** (daily, GitHub Actions) asks the API for the next NEW batch
   — already filtered against the unsubscribe suppression list — sends via Resend
   from **`trypeekscout.com`** (never the primary `peekscout.com` domain), and
   marks each lead `SENT`. Send-state is in the DB, so cloud runs never repeat.
3. **Ramp:** a fresh sending domain must warm up. The daily cap grows with the
   weeks since the first send — default `15 → 25 → 40 → 50`/day — with zero date
   config (the server reports `firstSentAt`).

Weekends are skipped (cron is Mon–Fri; the script double-checks).

## One-time setup

### 1. Seed your leads (run locally, never in CI)

Build a master CSV with the [ig-email-extractor](https://github.com/danelas/gold-touch-social/tree/main/ig-email-extractor)
pipeline, then:

```bash
ADMIN_TOKEN=<peekscout admin token> \
  node src/seed.mjs ../gold-touch-list/ig-email-extractor/out/master-XXXX.csv
```

Idempotent — re-run any time to add new leads; existing ones (and their sent
status) are untouched.

### 2. Configure GitHub Actions

**Repository → Settings → Secrets and variables → Actions**

Secrets (sensitive):

| Secret | Value |
|--------|-------|
| `ADMIN_TOKEN` | PeekScout's `ADMIN_TOKEN` (same one guarding the outreach/unsubscribe APIs) |
| `RESEND_API_KEY` | Resend key for the account where **trypeekscout.com is a verified domain** |
| `MAILING_ADDRESS` | Your physical mailing address (CAN-SPAM requires it in the footer) |

Variables (not sensitive):

| Variable | Value |
|----------|-------|
| `OUTREACH_API_BASE` | `https://www.peekscout.com` |
| `OUTREACH_FROM_EMAIL` | `Peek Scout <hello@trypeekscout.com>` |
| `RAMP` | `15,25,40,50` (optional — this is the default) |

That's it. The workflow runs weekday mornings automatically.

## Manual use

```bash
npm run dry     # preview today's batch, send nothing
npm run send    # send today's ramped batch
```

Or trigger the workflow by hand: **Actions → daily-outreach → Run workflow**
(check "Preview only" for a dry-run).

## Guardrails

- Sends **only** from `trypeekscout.com` — refuses any other From domain.
- Honors unsubscribes (the API filters them out before handing over a batch).
- Marks `SENT` in the DB → no double-sends across runs.
- CAN-SPAM: `List-Unsubscribe` header + unsubscribe link + physical address.

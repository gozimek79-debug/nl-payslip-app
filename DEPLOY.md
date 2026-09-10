# Deployment runbook

## Prerequisites
- `DATABASE_URL` for the production Neon database, available locally.
- Push access to `origin/main` (GitHub-connected Vercel project).

## 1. Apply the database migration (rate limiting)
```bash
psql "$DATABASE_URL" -f packages/database/migrations/004-rate-limits.sql
```

## 2. Seed / update the legal_rules reference data
```bash
DATABASE_URL="$DATABASE_URL" node scripts/seed-legal-rules.mjs
```
Expect output listing each rule/version as either `inserted version N` or `unchanged, skipping`.

## 3. Set required Vercel environment variables (if not already set)
```bash
vercel env add CRON_SECRET production
```
Generate a random value yourself (e.g. `openssl rand -hex 32`) — this gates `GET /api/maintenance/cleanup-expired`, which Vercel Cron calls automatically per `vercel.json`.

## 4. Deploy
```bash
git push origin main
```
Vercel is GitHub-connected; a push to `main` triggers the build automatically. No `vercel deploy` needed.

## 5. Verify after deploy
```bash
curl -s https://nl-payslip-app.vercel.app/api/health
```
Expect `{"status":"ok","database":"connected"}`.

```bash
curl -s -X POST https://nl-payslip-app.vercel.app/api/calculator/calculate \
  -H "Content-Type: application/json" \
  -d '{"periodType":"maand","baseHourlyRate":16,"hours":{"normal":160,"saturday":0,"sunday":0,"holiday":0,"night":0},"toeslagPercentages":{"saturday":25,"sunday":50,"holiday":100,"night":15},"overtime":{"tier1":{"hours":0,"multiplier":1.25},"tier2":{"hours":0,"multiplier":1.5}},"includeVakantiegeld":true,"applyThirtyPercentRuling":false,"applyLoonheffingskorting":true,"advanced":{"enabled":false,"pensionMode":"none","pensionPremiumPercent":0,"pawwPercent":0,"sicknessInsurancePercent":0,"wgaPremiumPercent":0,"travelAllowance":0,"otherDeductions":0,"applyBijzonderTarief":false}}'
```
Expect `"ratesSource":"database"` once step 2 has run; `"static"` if not yet seeded.

Confirm the Vercel Cron job is registered: Vercel dashboard → project → Settings → Cron Jobs → `/api/maintenance/cleanup-expired` should show a schedule of `0 3 * * *`.

## 6. Rollback
```bash
git revert <bad-commit-sha>
git push origin main
```
Triggers a new build reverting the code. The database migration (step 1) and seed data (step 2) are additive/idempotent and do not need reverting for a code-only rollback. If a bad seed value was applied, re-run step 2 after fixing the source data in `packages/tax-tables/2026-rates.json` — `getRuleAt`/`getCurrentRule` always pick the latest version, so a corrected re-seed supersedes the bad one without deleting history.

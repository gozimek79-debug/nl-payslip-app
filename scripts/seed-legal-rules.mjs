// Seeds/updates the `legal_rules` and `legal_rule_versions` tables — the reference database the
// calculator, contract analysis and payslip analysis all read from at runtime (rules-repository.ts).
//
// AUDIT R4/I2: the original version of this script (which populated the 5 rows currently live in
// production) was deleted after running, per an established-but-wrong pattern in earlier rounds of
// this engagement ("delete the seed script once it's run"). The consequence showed up directly in
// audit round 3/A4: this session could not answer what the production database actually contains,
// because nothing in the repository said so. Going forward, every seed and migration script is
// committed and kept — this file included, regardless of whether it has been run yet.
//
// WHAT IS RECONSTRUCTED VS VERIFIED VS UNKNOWN (read this before running):
//
//   loonheffing_nl (2 versions: H1 and H2 2026)
//     VERIFIED this session (round 4), against primary sources, not carried over:
//       - loonheffing_brackets, bijzonder_tarief_brackets: rijksoverheid.nl / belastingdienst.nl
//       - bijzonder_tarief_loonheffingskorting_addon_tiers: belastingdienst.nl's own 2026 witte
//         tabel bijzondere beloning, re-verified boundary-by-boundary in round 5 (audit U3) against
//         the actual primary source PDF (wit_bb_nl_std_20260101.pdf) - no correction was needed,
//         every boundary already matched.
//       - heffingskortingen.algemene_heffingskorting, .arbeidskorting (all fields including the
//         corrected buildup_tiers): belastingdienst.nl's own arbeidskorting table page, AND
//         independently confirmed against the Olympia 2026-W36 payslip's printed arbeidskorting
//         figure (108.71/week) - see calculator.test.ts
//       - minimum_wage_per_hour: rijksoverheid.nl (14.71 for H1, 14.99 for H2)
//     Audit W1: this now IMPORTS packages/tax-tables/2026-rates.json directly instead of restating
//     the values inline - closing the JSON-vs-seed duplication flagged as NEW FINDING 3 last round,
//     before it could drift the way the static-vs-DB duplication did earlier in this engagement.
//     There is exactly one place these numbers live; both the static fallback and this seed read it.
//
//   pensioenfonds_stipp
//     VERIFIED this session (round 4), against stippensioen.nl's own "definitieve cijfers 2026"
//     page: franchise_per_hour, max_pensionable_hourly_wage, employee_rate all confirmed correct.
//     NOTE: the pensionable-wage BASIS these parameters are applied to is still PROVISIONAL per
//     audit P4 - see calculator.ts's computePension() - the rate/franchise/cap themselves are not
//     in question, only what wage figure they're applied to.
//
//   arbeidsrecht_proeftijd, arbeidsrecht_opzegtermijn_werkgever
//     NOT RE-VERIFIED this session. These values (art. 7:652 BW probation-period limits, art. 7:672
//     BW notice-period tiers) were carried over unchanged from the original implementation in an
//     earlier round of this engagement, before the "commit and keep scripts" rule existed - this
//     script reconstructs them from what is currently live in calculator/contract.ts's static
//     fallback constants (STATIC_PROEFTIJD, STATIC_OPZEGTERMIJN in contract.ts), which match what
//     the seeded DB values are presumed to be. Treat as carried-over, not independently confirmed
//     this round. Re-verifying these against wetten.overheid.nl is recommended before relying on
//     this seed as authoritative.
//
//   cao_abu_uitzendkrachten
//     AUDIT V3 (round 5): this rule previously carried placeholder Saturday/Sunday percentages
//     (25%/50%) explicitly flagged as unverified. Per your own NEW FINDING 2 from round 4: the ABU
//     CAO does not fix a CAO-wide toeslag percentage at all — it requires equivalence with whatever
//     the hirer's own regular employees receive, which varies per assignment. A default number here
//     was never going to be correct for a real assignment; it was the same failure shape as the
//     monthly minimum-wage default from round 1 (a wrong default is worse than an absent one). The
//     parameters below now say exactly that — no percentages, an explicit "no default exists" state
//     — rather than a plausible-looking number nothing actually backs. Still not consumed by any
//     code path (confirmed via grep): kept only so the rule exists as a documented non-answer,
//     pending the data-model rewrite (audit V1) that would let this be sourced from the document or
//     the user instead of a table row.
//
// USAGE: run against the production database with a real DATABASE_URL in the environment:
//   DATABASE_URL="postgresql://..." node scripts/seed-legal-rules.mjs
// Idempotent: re-running creates a new version row only if the parameters differ from the current
// one for that (code, valid_from) pair; running it twice with no changes is a no-op.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const taxRatesFile = JSON.parse(readFileSync(path.resolve(scriptDir, '../packages/tax-tables/2026-rates.json'), 'utf-8'));
function loonheffingParamsFor(periodId) {
  const period = taxRatesFile.periods.find((p) => p.id === periodId);
  if (!period) throw new Error(`Period "${periodId}" not found in 2026-rates.json`);
  // Strip the file's own documentation-only fields (id, sources, _*_note) - legal_rule_versions
  // rows carry their source via the dedicated source_url column, not an in-JSON array.
  const { id, sources, last_verified, _source_correction_note, _bijzonder_tarief_addon_note, ...params } = period;
  if (params.heffingskortingen) {
    const { _arbeidskorting_verification_note, ...heffingskortingen } = params.heffingskortingen;
    params.heffingskortingen = heffingskortingen;
  }
  return params;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Refusing to run against an unknown/default database.');
  process.exit(1);
}

const pool = new Pool({ connectionString });

const RULES = [
  {
    code: 'loonheffing_nl',
    title: 'Nederlandse loonheffing, heffingskortingen en minimumloon',
    versions: [
      {
        valid_from: '2026-01-01',
        valid_to: '2026-06-30',
        parameters: loonheffingParamsFor('tax_2026_h1'),
        source_url: 'https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/arbeidskorting/tabel-arbeidskorting-2026',
      },
      {
        valid_from: '2026-07-01',
        valid_to: '2026-12-31',
        parameters: loonheffingParamsFor('tax_2026_h2'),
        source_url: 'https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/arbeidskorting/tabel-arbeidskorting-2026',
      },
    ],
  },
  {
    code: 'pensioenfonds_stipp',
    title: 'StiPP pensioenfonds — franchise, maximum en werknemersbijdrage',
    versions: [
      {
        valid_from: '2026-01-01',
        valid_to: '2026-12-31',
        parameters: { franchise_per_hour: 9.24, max_pensionable_hourly_wage: 42.42, employee_rate: 0.075 },
        source_url: 'https://www.stippensioen.nl/werkgever/nieuws/definitieve-cijfers-en-bedragen-2026-zijn-bekend/',
      },
    ],
  },
  {
    code: 'arbeidsrecht_proeftijd',
    title: 'Maximale proeftijd (art. 7:652 BW) — NOT RE-VERIFIED this session, carried over',
    versions: [
      {
        valid_from: '2020-01-01',
        valid_to: null,
        parameters: { max_weeks_short_contract: 4.3, short_contract_threshold_months: 24, max_weeks_long_contract: 8.7 },
        source_url: 'https://wetten.overheid.nl/BWBR0005290/#Boek7_Titeldeel10_Afdeling2_Artikel652',
      },
    ],
  },
  {
    code: 'arbeidsrecht_opzegtermijn_werkgever',
    title: 'Minimale opzegtermijn werkgever naar diensttijd (art. 7:672 BW) — NOT RE-VERIFIED this session, carried over',
    versions: [
      {
        valid_from: '2020-01-01',
        valid_to: null,
        parameters: {
          tiers: [
            { max_years: 5, months: 1 },
            { max_years: 10, months: 2 },
            { max_years: 15, months: 3 },
            { max_years: 999, months: 4 },
          ],
        },
        source_url: 'https://wetten.overheid.nl/BWBR0005290/#Boek7_Titeldeel10_Afdeling2_Artikel672',
      },
    ],
  },
  {
    code: 'cao_abu_uitzendkrachten',
    title: 'CAO ABU uitzendkrachten — geen vast CAO-breed toeslagpercentage (audit V3)',
    versions: [
      {
        valid_from: '2026-01-01',
        valid_to: '2026-12-31',
        parameters: {
          has_default_toeslag: false,
          reason: 'De CAO ABU voor Uitzendkrachten stelt geen vast Saturday/Sunday-toeslagpercentage CAO-breed vast - de uitzendkracht heeft recht op dezelfde onregelmatigheidstoeslag-regeling als een vergelijkbare werknemer bij de inlener, wat per opdracht verschilt. Een vaste standaardwaarde hier zou dezelfde fout zijn als het maandelijkse minimumloon-defect uit ronde 1: een verkeerde standaardwaarde is erger dan geen standaardwaarde. De daadwerkelijke waarde moet uit het document (pasklip/CAO van de inlener) of van de gebruiker komen, niet uit deze tabel.',
        },
        source_url: 'https://www.abu.nl/app/uploads/2026/01/CAO-voor-Uitzendkrachten-2026-2028.pdf',
      },
    ],
  },
];

async function upsertRule(rule) {
  const { rows: existingRule } = await pool.query('SELECT id FROM legal_rules WHERE code = $1', [rule.code]);
  let ruleId = existingRule[0]?.id;
  if (!ruleId) {
    const { rows } = await pool.query(
      `INSERT INTO legal_rules (code, title, jurisdiction) VALUES ($1, $2, 'NL') RETURNING id`,
      [rule.code, rule.title],
    );
    ruleId = rows[0].id;
    console.log(`Created legal_rules row for "${rule.code}"`);
  } else {
    await pool.query('UPDATE legal_rules SET title = $2 WHERE id = $1', [ruleId, rule.title]);
  }

  for (const version of rule.versions) {
    const { rows: current } = await pool.query(
      `SELECT version, parameters FROM legal_rule_versions WHERE legal_rule_id = $1 AND valid_from = $2 ORDER BY version DESC LIMIT 1`,
      [ruleId, version.valid_from],
    );
    const currentParams = current[0]?.parameters ? JSON.stringify(current[0].parameters) : null;
    const newParams = JSON.stringify(version.parameters);
    if (currentParams === newParams) {
      console.log(`  ${rule.code} @ ${version.valid_from}: unchanged, skipping`);
      continue;
    }
    const nextVersion = (current[0]?.version ?? 0) + 1;
    await pool.query(
      `INSERT INTO legal_rule_versions (legal_rule_id, version, valid_from, valid_to, parameters, source_url, published_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())`,
      [ruleId, nextVersion, version.valid_from, version.valid_to, newParams, version.source_url],
    );
    console.log(`  ${rule.code} @ ${version.valid_from}: inserted version ${nextVersion}`);
  }
}

async function main() {
  for (const rule of RULES) {
    await upsertRule(rule);
  }
  await pool.end();
  console.log('Done.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

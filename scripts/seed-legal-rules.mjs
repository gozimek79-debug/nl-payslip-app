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
//         tabel bijzondere beloning (see packages/tax-tables/2026-rates.json for the full URL)
//       - heffingskortingen.algemene_heffingskorting, .arbeidskorting (all fields including the
//         corrected buildup_tiers): belastingdienst.nl's own arbeidskorting table page, AND
//         independently confirmed against the Olympia 2026-W36 payslip's printed arbeidskorting
//         figure (108.71/week) - see calculator.test.ts
//       - minimum_wage_per_hour: rijksoverheid.nl (14.71 for H1, 14.99 for H2)
//     Parameters here are copied directly from packages/tax-tables/2026-rates.json, which is the
//     single source of truth for both the static fallback AND this seed - do not let the two drift;
//     if you edit one, edit both or extract a shared JSON import (not done here, kept simple).
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
//     LARGELY UNKNOWN. This session could not recover what was originally seeded for this rule -
//     it is not referenced anywhere in the current codebase (confirmed via grep: zero usages), so
//     there was nothing to reverse-engineer it from. The values below (Saturday 25% / Sunday 50%)
//     are commonly-cited defaults from secondary sources, offered here only as a placeholder - and
//     even the ABU CAO's own text (abu.nl) says these percentages are NOT fixed CAO-wide, but
//     depend on "equivalence with the hirer's own regular employees," i.e. the actual applicable
//     percentage varies per assignment. Do not treat this row as authoritative for any real
//     calculation; it is seeded only so the rule exists with SOME value rather than none, and is
//     flagged here so nobody mistakes it for a verified figure the way this session was told to
//     stop doing. Recommend either removing this rule entirely (nothing consumes it) or properly
//     scoping what it should represent before trusting it.
//
// USAGE: run against the production database with a real DATABASE_URL in the environment:
//   DATABASE_URL="postgresql://..." node scripts/seed-legal-rules.mjs
// Idempotent: re-running creates a new version row only if the parameters differ from the current
// one for that (code, valid_from) pair; running it twice with no changes is a no-op.

import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Refusing to run against an unknown/default database.');
  process.exit(1);
}

const pool = new Pool({ connectionString });

const LOONHEFFING_H1 = {
  year: 2026,
  minimum_wage_per_hour: 14.71,
  loonheffing_brackets: [
    { min: 0, max: 38883, rate: 0.3575 },
    { min: 38883, max: 78426, rate: 0.3756 },
    { min: 78426, max: 999999999, rate: 0.495 },
  ],
  bijzonder_tarief_brackets: [
    { min: 0, max: 38883, rate: 0.3575 },
    { min: 38883, max: 78426, rate: 0.3756 },
    { min: 78426, max: 999999999, rate: 0.495 },
  ],
  bijzonder_tarief_loonheffingskorting_addon_tiers: [
    { max: 11358, addon: 0.0 },
    { max: 12923, addon: -0.0832 },
    { max: 23931, addon: -0.3101 },
    { max: 29737, addon: -0.0195 },
    { max: 45593, addon: 0.0445 },
    { max: 78427, addon: 0.1291 },
    { max: 143555, addon: 0.0651 },
    { max: 999999999, addon: 0.0 },
  ],
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: 3115, phaseout_start: 29736, phaseout_rate: 0.06398 },
    arbeidskorting: {
      max_amount: 5685,
      phaseout_start: 45592,
      phaseout_rate: 0.0651,
      buildup_tiers: [
        { max: 11965, rate: 0.08324 },
        { max: 25845, rate: 0.31009 },
        { max: 45592, rate: 0.0195 },
      ],
    },
  },
};

const LOONHEFFING_H2 = { ...LOONHEFFING_H1, minimum_wage_per_hour: 14.99 };

const RULES = [
  {
    code: 'loonheffing_nl',
    title: 'Nederlandse loonheffing, heffingskortingen en minimumloon',
    versions: [
      {
        valid_from: '2026-01-01',
        valid_to: '2026-06-30',
        parameters: LOONHEFFING_H1,
        source_url: 'https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/arbeidskorting/tabel-arbeidskorting-2026',
      },
      {
        valid_from: '2026-07-01',
        valid_to: '2026-12-31',
        parameters: LOONHEFFING_H2,
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
    title: 'CAO ABU uitzendkrachten — indicatieve toeslagen (ONGEVERIFIEERD, niet gebruikt in code)',
    versions: [
      {
        valid_from: '2026-01-01',
        valid_to: '2026-12-31',
        parameters: {
          _warning: 'Placeholder only - see the file-level comment above. Not consumed by any code path. The ABU CAO itself does not fix these as flat percentages; they depend on equivalence with the hirer\'s own employees.',
          saturday_percent: 25,
          sunday_percent: 50,
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

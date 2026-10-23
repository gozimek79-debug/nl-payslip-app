# RAPORT WYKONAWCY — P1.1 (Overtime evidence semantics fix)

**Status:** P1.1 DONE — ordinal overtime tier inference removed, observed premiums kept as neutral evidence, F8/F9/F10 closed. Pushed for Cursor re-review. Holding.
**Blocking:** nothing.

| | |
|---|---|
| Base (reviewed) SHA | `ff3700eb63c08172bf81338ad9a7630d3a680427` |
| New commit | `2b7e88ce7b6242027b08c80f7274ca6739fcc1a0` (parent `ff3700e`) — one commit |
| Branch | `p1-payroll-profile`, **pushed**: `origin/p1-payroll-profile` = `2b7e88c` (verified with `git ls-remote`) |
| `main` | unchanged at `b5847a0`; no merge, no deploy |
| Review report addressed | `RAPORT-cursor-P1.md` (branch `cursor/p1-independent-review-d62b`) |

Design record updated in place: `LOONTO-PRO-P1-PAYROLL-PROFILE.md` (header note, §2.3, §3, §5.2, new §5.4, §6.2, §6.3, §7, §8, new §9).

---

## 1. EXECUTIVE RESULT

- No overtime percentage is assigned a tier any more. `overtimeTier1Premium` / `overtimeTier2Premium` have no candidates unless a source explicitly identifies the tier; no P1 input does, so both are `unknown` with reason `tier_identity_not_evidenced` whenever overtime was observed.
- Every genuine overtime premium is preserved as tier-neutral evidence in the new `observedOvertimePremiums` section: premium above base (150 % → +50), document, pay period, printed label, printed percent; corroborated across documents; never in conflict merely because payslips show different sets of premiums.
- Overtime lines with no printed percent are now excluded evidence (`percent_not_printed`), and the < 100 % ambiguity is recorded once on the observed evidence, not copied onto tier fields.
- Live prefill can only fill the tier inputs from the tier fields, so with today's extraction the tier inputs stay empty; observed premiums are shown in the inspection view and named on the projection, never prefilled.
- Changing the as-of date after a submit re-resolves the profile from the already-read facts through the pure endpoint (no document re-read, no Gemini), with the stale profile cleared immediately.
- Everything else in P1 is unchanged. Backend 335/335, frontend 55/55, both typechecks and the frontend build are green.

## 2. CURSOR FINDINGS ADDRESSED

| Finding | Severity | Resolution in `2b7e88c` |
|---|---|---|
| F1 — lone overtime percentage assigned tier 1 (false tier-1 conflict, suppressed prefill) | MAJOR | Fixed: no tier is ever assigned from a percentage. Lone 150 % → observed +50, both tiers `unknown`. A {150 %} + B {125 %, 150 %} → no conflict; +25 (B) `document_exact`, +50 (A, B) `corroborated`. Tests P1.1 #1, #4. |
| F7 — two-percent lowest→tier 1 / highest→tier 2 is ordinal | NOTE | Fixed with F1: ordering, count and position are no longer used; `overtimeAdditionalTierPremiums` (the "middle" slot) removed. Tests P1.1 #2, #3. |
| F8 — overtime line without a printed percent silently dropped | MINOR | Fixed: `observedOvertimePremiums.excluded` gets `percent_not_printed` with document/printed-label/amount. Test P1.1 #6. |
| F9 — ambiguous exclusions duplicated onto both tier fields | MINOR | Fixed: each ambiguous line is excluded exactly once in `observedOvertimePremiums.excluded`; tier fields carry no exclusions (asserted in every overtime test via `assertNoTierIdentity`). Test P1.1 #7. |
| F10 — profile stale after `asOfDate` change | MINOR | Fixed: `changeAsOfDate` re-resolves from cached facts; stale profile cleared at once; date input locked during reads. Tests P1.1 #9 (backend + frontend). |
| F2, F3, F4, F6 | NOTE/MEDIUM | Not in P1.1 scope (§9). |
| F5 — "Not pushed" stated in P1 docs | NOTE | Design record header corrected (pushed, with both SHAs). |

## 3. OVERTIME EVIDENCE MODEL AFTER P1.1

```
PayrollProfile.observedOvertimePremiums = {
  fields: ProfileField[]      // one per distinct observed premium
                              //   key      observed_overtime_premium:<premium>
                              //   meaning  overtime_premium_observed_tier_unknown
                              //   unit     premium_percent   (value = printed % − 100)
                              //   candidates: every genuine OT line with that premium
                              //     source: payslip, documentIndex/label, payPeriod, printedLabel
                              //     detail: printedPercent, hours, amount
                              //   state: document_exact (1 document) | corroborated (≥2 documents)
  excluded: ExcludedEvidence[] // percent_not_printed | percent_semantics_ambiguous — each line once
}
```

- Genuine overtime = `category: 'overtime'` and `adds_hours: true` (unchanged). Surcharges stay in `recurringItems.surcharges`.
- Grouping by premium value means a field cannot be in `conflict`: different payslips showing different premiums are separate observations. A conflict can only arise on an explicitly identified semantic field — and no overtime field with explicit identity exists yet.
- Ascending order of `fields` is display-only; it carries no tier meaning (stated in code).
- The < 100 % rule is unchanged in substance (P1.1.3 allows it to remain): a payslip printing an overtime rate below 100 % has none of its overtime percentages trusted as full multipliers; each of its overtime lines is excluded once.

## 4. TIER IDENTITY RULE

Implemented exactly as the binding rule: a source may populate `overtimeTier1Premium` or `overtimeTier2Premium` only if it explicitly establishes that tier identity. Never from percentage size, lowest/highest ordering, number of percentages, recency or array position.

Current inputs carry no explicit tier identity: `HourLine` has no tier field, and `ContractExtraction` has no percentage fields. Therefore both tier fields are always `unknown` in P1.1:
- `tier_identity_not_evidenced` when any overtime line was seen (observed or excluded);
- `no_payslip_document` / `not_on_payslips` otherwise.

Required test #8 ("explicitly tier-identified synthetic source, ONLY if the schema genuinely supports it"): the schema does not, so no test-only signal was invented. Instead, test P1.1 #8 pins the negative: even a line *printed* "Overwerk 1e schijf 125%" stays tier-neutral (printed text is not a structured tier identity and is deliberately not parsed), and the contract-stated threshold still resolves independently.

## 5. LIVE PREFILL BEHAVIOR

- `profilePrefill` is unchanged in logic: `overtime_tier_1_percent`/`overtime_tier_2_percent` come only from `overtimeTier1Premium`/`overtimeTier2Premium` in a usable state. Both are `unknown` today, so both inputs stay empty with no badge.
- `profilePrefill` does not read `observedOvertimePremiums` (frontend source test).
- The projection shows a note naming the observed premiums ("Paski pokazują dopłaty za nadgodziny (+25%, +50% …) ale żaden dokument nie mówi, który to próg …") so the user knows why the tier inputs are empty; the inspection table lists each observed premium (group "Nadgodziny zaobserwowane (próg nieznany)") and the excluded overtime lines.
- Hourly rate, hours per week and overtime threshold prefill exactly as in P1. No Basic estimate is labelled as document evidence.

## 6. AS-OF-DATE RE-RESOLUTION

- `submitAll` caches the exact document list it sends to the resolver (`resolvedDocuments`).
- `changeAsOfDate(value)`: sets the date; if documents were already resolved → clears the profile, clears the error, remounts the calculator (empty), and, for a complete ISO date, calls `resolveProfile(value, resolvedDocuments)` — the pure `/api/profile/resolve`, nothing else. When it lands: new profile (new `asOfDate`, `contractContext`, timeline-dependent fields), calculator remounts with the new prefill. While in flight the calculator is hidden and a "re-resolving" note shows.
- A request counter drops late responses; a cleared/half-typed date leaves no profile; a failed call shows the profile error, never the old profile.
- The date input is disabled while documents are being read, so a submit cannot complete under a date different from the one it resolved.
- No Gemini/document call on a date change: `resolveProfile` calls exactly one URL (tested with an injected fetch), and `changeAsOfDate` references none of `processPayslip`, `processContract`, `renderPageImages`, `extractTextItems`, `/api/tier-c/analyze`, `/api/contracts/analyze` (source test).

## 7. TESTS / TYPECHECKS / BUILD

All offline, synthetic data only; `DATABASE_URL`/`GROQ_API_KEY` blanked for the backend run (as CI); no `GEMINI_API_KEY`.

| Command | Result |
|---|---|
| `npm run test --workspace @nl-payslip/backend` | **335 / 335 pass** |
| `npm run typecheck --workspace @nl-payslip/backend` | exit 0 |
| `npm run test --workspace @nl-payslip/frontend` (Node 24) | **55 / 55 pass** |
| `npm run typecheck --workspace @nl-payslip/frontend` | exit 0 |
| `npm run build --workspace @nl-payslip/frontend` | exit 0 |

ZADANIE §P1.1.7 mapping:

| # | Test(s) |
|---|---|
| 1 | backend `P1.1 #1` (observed +50; tier 1/2 unknown, reason `tier_identity_not_evidenced`); frontend `P1.1 #1/#4` (prefill receives neither tier); HTTP test (lone 150 % → tier unknown, observed +50) |
| 2 | backend `P1.1 #2` (+25, +50 observed; no tier) |
| 3 | backend `P1.1 #3` (+25, +50, +100 observed; no tier; ordinal slot no longer exists) |
| 4 | backend `P1.1 #4` (A {150} + B {125,150}: no conflict, provenance of both payslips) |
| 5 | backend `P1.1 #5` (same premiums on two documents → corroborated, no tier) |
| 6 | backend `P1.1 #6` (`percent_not_printed` visible with label/amount) |
| 7 | backend `P1.1 #7` (each sub-100 %-payslip line excluded once; tiers carry no exclusions) |
| 8 | backend `P1.1 #8` — negative form, see §4 (schema has no explicit tier identity) |
| 9 | backend `P1.1 #9 (backend half)` (new date moves annex into force, rate and context follow); frontend `P1.1 #9` ×3 (one pure call with cached facts + new date; failure → null; live handler re-resolves, clears, remounts, never re-reads) |
| 10 | HTTP `P1.7` audit-state test (unchanged, green); backend `P1.8 #4/#12` (payslip with real finding still yields its observed premiums); frontend `P1.8 #13` (old gate not imported/called) |
| 11 | all P1 independence/conflict tests green (`P1.8 #1–#3, #8–#11, #14`, timeline, undated annex, recurring items…) |
| 12 | table above |

Tests changed because they encoded the rejected ordinal rule (per "do not preserve obsolete behaviour merely because an old test encoded it"): `P1.8 #5`, `#6`, `#7`, "third distinct percentage", "< 100 %" (all replaced by `P1.1 #1–#7`), the tier asserts inside `P1.8 #4/#12`, `#9` and the unconfirmed-period-type test, the HTTP happy-path tier assert, and two frontend P1 source asserts that pointed at the inline `fetch` (now inside `resolveProfile`). The frontend PL/EN key list was updated for the replaced keys.

## 8. FILES CHANGED

Commit `2b7e88c` (parent `ff3700e`), 7 files, +362 / −118:

```
M apps/backend-node/src/payroll-engine/payroll-profile.ts
M apps/backend-node/src/payroll-engine/payroll-profile.test.ts
M apps/backend-node/src/controllers/profile.controller.test.ts
M apps/frontend-react/src/pro-profile-prefill.ts
M apps/frontend-react/src/pro-profile-prefill.test.ts
M apps/frontend-react/src/ProDocuments.tsx
M apps/frontend-react/src/translations.ts
```

Translations: `projectionAdditionalTiers` (P1 key) replaced by `projectionObservedOvertime`; added `profileGroupObservedOvertime`, `profileObservedOvertimeExcluded`, `profileResolving` — PL and EN.

Untouched: engine, contract timeline, hour grid, rules layer, Tier A, controllers (other than the test file), Gemini code, `local-ocr.ts`. The four pre-existing untracked items remain untouched and uncommitted.

## 9. NOT DONE AND WHY

Out of P1.1 scope by instruction (§P1.1.6), unchanged from P1: time-aware supersession of older payslip rates (F2, P3); period-type-unknown payslips omitted from the profile request (F3, P2); diagnostic-panel corrections re-resolving the profile (F4, P3); dead old sourcing modules incl. `derivePayslipOvertimePercents` and its tests that still teach "single percentage is tier 1" (F6, cleanup later); Gemini schema, 3-page cap (P2); tax years (P4/P6); weekend/holiday (P5); calibration (P6).

No browser run of the full PRO flow (needs a paid Gemini read of documents); the new date path is covered by the injected-fetch and source tests.

## 10. NEW FINDINGS

- **N1 (INFO, consequence of the binding rule)** — With today's extraction, PRO never prefills overtime tiers: no source states tier identity. Until P2/P5 add explicit tier evidence (e.g. a structured tier field, or a contract clause stating which percentage applies after the threshold), the user enters both tier percentages manually; the observed premiums are shown next to the calculator to help.
- **N2 (LOW)** — The calculator remounts on every as-of date change (to keep prefill consistent with the new profile), so manual entries in the calculator are lost when the date changes. Same mount-time prefill pattern as P1; a field-preserving merge is UX work (P3/P4).
- **N3 (LOW)** — While a submit is reading documents the previous calculator (previous submit's prefill) stays visible until the new profile lands; unchanged from P1, now noted. The date input is locked during that window.
- **N4 (INFO, from Cursor §12)** — On Node 22 the frontend test script needs `--experimental-strip-types` (it runs as-is on Node 24 here), and CI does not run frontend unit tests at all. Tooling change not made (out of scope); flagged for a later cleanup decision.
- **N5 (INFO)** — Old P1 translation keys made unused in P1 (`payslipEligibleForProjection`, `projectionPayslipUsed`, …) remain; cleanup later.

## 11. P1 EXIT READINESS

| P1.1 exit criterion | Status |
|---|---|
| 1. No generic overtime percentage assigned tier 1/2 by numeric order | Met (`overtimeEvidence` has no ordering; tests #2/#3) |
| 2. Lone 150 % cannot populate tier 1 | Met (test #1, HTTP test) |
| 3. Multi-rate payslips receive no invented ordinal tiers | Met (tests #2/#3/#4) |
| 4. Observed premiums preserved with provenance | Met (`observedOvertimePremiums`; tests #1–#5) |
| 5. Missing/ambiguous percent explicitly excluded, not dropped | Met (tests #6/#7) |
| 6. Live prefill receives OT tiers only from explicit tier identity | Met (`profilePrefill` reads only tier fields; source + mapping tests) |
| 7. `asOfDate` cannot display a stale profile | Met (`changeAsOfDate`; tests #9) |
| 8. Old auditor remains disconnected | Met (P1 tests unchanged and green) |
| 9. No P2–P6 scope pulled forward | Met (§9) |
| 10. All automated verification green | Met (§7) |

P1 + P1.1 are ready for Cursor re-review. P2 not started.

## 12. REVIEW HANDOFF

- Branch `origin/p1-payroll-profile` @ `2b7e88ce7b6242027b08c80f7274ca6739fcc1a0`; review the correction with `git diff ff3700e 2b7e88c`, the whole round with `git diff b5847a0 2b7e88c`.
- Suggested checks:
  1. `payroll-profile.ts` — `overtimeEvidence` (no sort/ordering), `observedOvertimeFields` (group by premium), tier fields via `unknownField(…, tierReason)`.
  2. Backend tests `P1.1 #1–#9` and `assertNoTierIdentity`.
  3. `pro-profile-prefill.ts` — `profilePrefill` unchanged and not reading observed premiums; `resolveProfile`.
  4. `ProDocuments.tsx` — `changeAsOfDate`, `resolvedDocuments`, `hasSubmitted && !resolvingProfile`, date input `disabled={submitting}`.
  5. Re-run both suites, typechecks and the frontend build.
- No merge, no deploy. Holding for Cursor re-review.

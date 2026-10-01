# RAPORT-cursor-P1.1 — Independent re-review of P1 correction

**Reviewer:** Cursor (read-only)  
**Round:** P1.1 correction  
**Branch:** `origin/p1-payroll-profile`  
**Correction commit:** `2b7e88ce7b6242027b08c80f7274ca6739fcc1a0`  
**Base reviewed P1 commit:** `ff3700eb63c08172bf81338ad9a7630d3a680427`  
**Main:** `b5847a02122b2fcf3383f1a1fabe95920ad45790`  
**Date (UTC):** 2026-10-01  
**Inputs:** `REVIEW-TASK-P1.1.md`, `RAPORT-wykonawca-P1.1.md` (chat attachments). Updated design record `LOONTO-PRO-P1-PAYROLL-PROFILE.md` still not attached as a file; executor states it was updated locally “in place” (not part of commit `2b7e88c`).  
**Production code modified:** no  
**P2 started:** no  

---

## 1. EXECUTIVE RESULT

**P1 + P1.1 is ACCEPTED for P2.**

Correction `2b7e88c` closes the P1 acceptance blocker and the related overtime/as-of findings:

- Generic overtime percentages no longer populate `overtimeTier1Premium` / `overtimeTier2Premium`.
- Neutral `observedOvertimePremiums` preserves printed premiums with provenance and does not reach live tier prefill.
- Missing-percent and &lt;100% overtime lines are excluded once on that neutral section (F8/F9).
- `asOfDate` changes re-resolve from cached document facts via `/api/profile/resolve` only, clearing the old profile first (F10).

Architecture from P1 remains intact: one backend-owned profile, old `fullyReproduced` gate still disconnected. Independent tests/typechecks/build are green. Scope stayed inside the correction.

---

## 2. PRIORITY ANSWERS

1. **F1 closed?** **Yes.** Lone OT% is observed-only; tiers stay `unknown` / `tier_identity_not_evidenced`.
2. **F7 closed?** **Yes.** Lowest/highest/middle ordinal tiering removed; `overtimeAdditionalTierPremiums` gone.
3. **F8 closed?** **Yes.** No-percent genuine OT → excluded `percent_not_printed` with label/doc/amount.
4. **F9 closed?** **Yes.** Ambiguous &lt;100% lines excluded once on `observedOvertimePremiums.excluded`; tier fields get empty `excluded`.
5. **F10 closed?** **Yes.** `changeAsOfDate` clears profile, re-resolves from `resolvedDocuments`, request-id guard, failure leaves null + error (not stale profile).
6. **Can generic OT% still populate tier1/tier2?** **No.** Tier fields are always `unknownField(...)` in P1.1; no candidates.
7. **Can observed OT reach live tier prefill?** **No.** `profilePrefill` reads only tier fields; source test proves it never mentions `observedOvertimePremiums`.
8. **Does asOfDate re-resolution avoid document/Gemini re-read?** **Yes.** Only `resolveProfile` → `/api/profile/resolve`; handler forbids analyze/OCR/render paths.
9. **Old auditor still disconnected?** **Yes.** No reintroduction into profile/prefill path.
10. **Scope OK?** **Yes.** 7 files, one commit on top of `ff3700e`; no Gemini/engine/timeline/rules/P2–P6 pull-forward.
11. **Tests green?** **Yes.** Backend **335/335**, frontend **55/55** (with type-stripping), both typechecks + FE build OK.
12. **P1 + P1.1 ACCEPTED for P2?** **Yes — ACCEPTED.**

---

## 3. FINDINGS

### Closed (verified)

| ID | Status | Evidence |
|---|---|---|
| F1 | **Closed** | R2 reconstruction: 150-only → observed +50; tiers unknown; prefill has no tier percents |
| F7 | **Closed** | 125+150+200 all observed; no additional-tier payroll key; no ordinal assignment |
| F8 | **Closed** | Test P1.1 #6 + code path emitting `percent_not_printed` |
| F9 | **Closed** | Test P1.1 #7; tier `excluded.length === 0` in reconstruction |
| F10 | **Closed** | `changeAsOfDate` + `resolveProfile` + request-id; tests P1.1 #9 |

### Open from P1 (unchanged; not P1.1 blockers)

| ID | Status | Note |
|---|---|---|
| P1 F3 | Still open (MEDIUM) | `unreliable` payslips still omitted by UI — P2 extraction topic |
| P1 F2 / N1 | Acceptable P1 limitation | Time-aware rate conflicts — P3 |
| P1 F4 / N5 | Acceptable P1 design | Diagnostic corrections do not re-resolve — P3 |

### New notes from P1.1

**N1 — NOTE (allowed):** Changing `asOfDate` remounts `TierACalculator` (`submitCount` bump on clear and on success), so manual calculator edits can be lost. Review task explicitly allows this LOW behavior.

**N2 — NOTE:** Ascending sort of observed premiums is display-only (`observedOvertimeFields`); no tier meaning. Verified.

**N3 — NOTE:** Printed label `"Overwerk 1e schijf 125%"` remains neutral observed +25; not parsed into tier identity (test P1.1 #8 + reconstruction).

**N4 — NOTE:** Updated design record still not in git / not attached; executor §0 says it was edited locally. Does not affect code acceptance.

No CRITICAL or MAJOR open findings on `2b7e88c`.

---

## 3a. CONTRACTOR CLAIM CHECK (`RAPORT-wykonawca-P1.1.md`)

| Claim | Verdict |
|---|---|
| Ordinal OT tier inference removed; tiers `unknown` / `tier_identity_not_evidenced` when OT seen | **Verified** |
| `observedOvertimePremiums` holds neutral premiums with provenance; different sets do not conflict | **Verified** |
| F1/F7/F8/F9/F10 closed as described | **Verified** (matches this review’s closure matrix) |
| Live prefill reads only tier fields; observed never prefilled | **Verified** |
| `asOfDate` re-resolves from cached facts via pure `/api/profile/resolve` only | **Verified** |
| One commit `2b7e88c` on `ff3700e`; 7 files +362/−118; pushed; `main` untouched | **Verified** |
| Backend 335/335, frontend 55/55, typechecks + FE build green | **Verified** independently (FE tests via type-stripping on Node 22) |
| Label “1e schijf” stays neutral; no invented schema signal for test #8 | **Verified** |
| F2/F3/F4/F6 left out of scope | **Accurate** |
| Design record updated in place | **Partial** — claimed locally; **not** in commit `2b7e88c` and not attached for inspection |
| N1–N5 (empty tier prefill consequence; remount loses manual inputs; calculator visible during submit; Node 22/CI FE-test note; unused old translation keys) | **Accurate** as notes; N2/N4 already noted in this review |

No material contradiction between executor report and source. Acceptance stands.

---

## 4. P1.1 FINDING-CLOSURE MATRIX

| Finding | Required closure | Result |
|---|---|---|
| F1 lone OT → tier1 | No tier identity; no live tier prefill | **Closed** |
| F7 ordinal heuristic | No lowest/highest/middle tier slots | **Closed** |
| F8 silent drop of no-percent OT | Excluded with reason + provenance | **Closed** |
| F9 duplicate ambiguous exclusions on tiers | Once on neutral evidence; tiers clean | **Closed** |
| F10 stale asOfDate profile | Clear + re-resolve from cache; no re-read | **Closed** |

---

## 5. OVERTIME SEMANTICS REVIEW

`overtimeEvidence` (`payroll-profile.ts`):

- Genuine OT = `category==='overtime' && adds_hours===true`.
- Usable printed percent → observed premium `percent - 100` (150 → +50).
- No lowest/highest/count/recency/position → tier mapping.
- Tier fields always `unknownField` with `tier_identity_not_evidenced` when any OT observed/excluded exists; otherwise payslip empty-reason.
- Surcharges (`adds_hours:false`) stay in `recurringItems.surcharges`.

### R2 case matrix (independent reconstruction)

| Case | Observed | Tier1 | Tier2 | Live tier prefill |
|---|---|---|---|---|
| 150% only | +50 `document_exact` | unknown / `tier_identity_not_evidenced` | same | none |
| 125%+150% | +25, +50 | unknown | unknown | none |
| 125%+150%+200% | +25, +50, +100 | unknown | unknown | none |
| A{150%}+B{125%,150%} | +25 (B), +50 corroborated (A+B); **no conflict** | unknown | unknown | none |
| Label “1e schijf 125%” | +25 observed | unknown | unknown | none |

Acceptance criteria met: no inferred tier identity; no false tier conflict; no observed premium auto-fills a tier.

---

## 6. NEUTRAL EVIDENCE REVIEW

`observedOvertimePremiums`:

- One field per distinct premium (`observed_overtime_premium:<premium>`), meaning `overtime_premium_observed_tier_unknown`.
- Provenance: document label, pay period, printed label, `detail.printedPercent`.
- Same premium across documents → `corroborated`.
- Different premiums → separate observations, not a conflict.
- Sort is display-only.
- Prefill never reads this section (function-body source test).
- UI shows observed premiums as an informational projection note and in the inspection table; copy states tiers stay empty for the user.

---

## 7. LIVE PREFILL TRACE

`ProDocuments` → `resolveProfile` → `setProfile` → `profilePrefill(profile, badge)` → `TierACalculator`.

- Tier inputs mapped only from `payroll.overtimeTier1Premium` / `overtimeTier2Premium`.
- With generic OT evidence those fields are unknown → empty inputs, no document badge on tiers.
- Hourly rate / hours/week / threshold behavior unchanged (still from employment fields when usable).
- Observed premiums do not become Basic/default document-sourced tier values.

---

## 8. AS-OF-DATE RE-RESOLUTION REVIEW

Verified in `ProDocuments.changeAsOfDate` + `resolveProfile`:

1. Date change after a submission uses cached `resolvedDocuments`.
2. Old profile cleared immediately (`setProfile(null)`); calculator remounted.
3. Incomplete date → no profile until a full ISO date.
4. Resolve call is only `POST /api/profile/resolve` with new `asOfDate` + cached docs.
5. Handler source excludes `processPayslip` / `processContract` / `renderPageImages` / `extractTextItems` / analyze URLs.
6. Backend half: same docs at later `asOfDate` moves annex into force and updates hourly rate (test P1.1 #9).
7. `profileRequestId` drops late/stale responses.
8. Failed resolve → `null` + error; does not restore previous profile under the new date.
9. Calculator hidden while `resolvingProfile`.

---

## 9. OLD AUDITOR DISCONNECTION

Re-checked: profile request still carries only period + `unreadableFieldPaths`. No `fullyReproduced` / discrepancy / needsConfirmation / confirmedIssueKeys in the resolve path. `ProDocuments` still does not import the retired sourcing symbols. Dead helpers remain in `pro-parameter-sourcing.ts` / `tier-c-shared.ts` as before.

---

## 10. REGRESSION / TYPE CONSISTENCY

- `overtimeAdditionalTierPremiums` / `premium_percent_list` removed from schema; no broken FE consumer found; projection note replaced by observed-overtime copy.
- Frontend `PayrollProfileView` includes `observedOvertimePremiums`.
- New PL/EN keys present and distinct (`projectionObservedOvertime`, `profileGroupObservedOvertime`, `profileObservedOvertimeExcluded`, `profileResolving`); parity covered by existing translations test + P1.8 #15 key list update.
- Recurring-item / conflict-independence tests still pass.
- HTTP profile test updated: lone 150% → observed +50, not a tier value.

---

## 11. INDEPENDENT TESTS

Environment: Node v22.14.0; secrets unset for backend tests.

| Command | Result |
|---|---|
| `npm run test --workspace @nl-payslip/backend` | **335 / 335 pass** |
| `npm run typecheck --workspace @nl-payslip/backend` | exit 0 |
| FE `node --experimental-strip-types --test` (all 6 scripts) | **55 / 55 pass** |
| `npm run typecheck --workspace @nl-payslip/frontend` | exit 0 |
| `npm run build --workspace @nl-payslip/frontend` | OK (existing chunk warning) |

Diff scope: exactly one commit `ff3700e..2b7e88c`, 7 files, not merged to `main`.

---

## 12. SCOPE CONTROL

Changed only profile resolver/tests, profile HTTP test, `ProDocuments`, `pro-profile-prefill` (+tests), translations. No Gemini prompt/schema, period-type-unknown extraction, annex-date extraction, page-cap, conflict UX, engine deduction feeding, weekend/holiday, calibration, or persistence.

---

## 13. WHAT WAS NOT VERIFIED

- Browser/Gemini end-to-end PRO flow (out of scope).
- Updated `LOONTO-PRO-P1-PAYROLL-PROFILE.md` body (claimed local-only update; not in commit, not attached).
- Whether future P2 will add structured tier identity to the schema (correctly absent today).

---

## 14. P2 READINESS

**Ready for P2** from a P1/P1.1 acceptance standpoint.

P2 may inherit the profile schema with honest unknown tiers and neutral observed OT evidence. Outstanding non-blocking items remain P1 F3 (`unreliable` payslip omission) and P3 topics (time-aware conflicts, user confirmation, diagnostic re-resolve).

---

## 15. REVIEW HANDOFF

- Review target: `p1-payroll-profile` @ `2b7e88c` (diff `ff3700e..2b7e88c`).
- Prior P1 review: `RAPORT-cursor-P1.md` (NOT ACCEPTED) — blocker closed by this correction.
- This report: `Loonto/RAPORT-cursor-P1.1.md` (and root copy) on `cursor/p1-1-rereview-d62b`.
- Executor report claim-checked after late attach (§3a); verdict unchanged: **ACCEPTED**.
- Production code untouched. P2 not started by this reviewer.

**HOLD for auditor decision.**

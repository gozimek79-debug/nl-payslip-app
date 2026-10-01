# RAPORT-cursor-P1 — Independent review

**Reviewer:** Cursor (read-only)  
**Round:** P1 — Payroll Profile v1  
**Branch reviewed:** `origin/p1-payroll-profile`  
**Tip:** `ff3700eb63c08172bf81338ad9a7630d3a680427`  
**Parent:** `b5847a02122b2fcf3383f1a1fabe95920ad45790`  
**Date (UTC):** 2026-10-01  
**Inputs read:** `REVIEW-TASK-P1.md`, `LOONTO-PRO-P1-PAYROLL-PROFILE.md`, `RAPORT-wykonawca-P1.md` (chat attachments; not in the commit)  
**Production code modified:** no  
**P2 started:** no  

---

## 1. EXECUTIVE RESULT

**P1 is NOT ACCEPTED for P2.**

The architecture reset is largely implemented correctly: one backend-owned `PayrollProfile`, one `resolveField` rule, payslip facts no longer gated by whole-document `fullyReproduced`, and the live PRO prefill path now reads `POST /api/profile/resolve`. Independent tests/typechecks/build are green.

One **MAJOR** semantic defect blocks acceptance: a payslip that shows a single overtime percentage is assigned `overtimeTier1Premium` identity without document proof. That false tier identity is copied into the live calculator prefill, and against a two-tier payslip it fabricates a tier-1 `conflict` that empties a valid tier-1 prefill.

Executor report N2 correctly *names* the issue, then incorrectly claims it does not block P2. Under `REVIEW-TASK-P1.md` severity guidance, it does.

---

## 2. PRIORITY ANSWERS

1. **Backend-owned single resolver?** **Yes.** Canonical semantics live in `payroll-profile.ts`; React only maps usable `state`/`value` to prefill.
2. **Can one conflict/unknown invalidate unrelated fields?** **No.** Per-field `resolveField`; verified by tests #3/#7/#9 and code structure.
3. **Can whole-payslip audit state still suppress a valid profile parameter?** **No** on the profile/prefill path. Discrepancy / needsConfirmation / fullyReproduced / confirmedIssueKeys are not resolver inputs.
4. **Is live PRO prefill sourced from the profile?** **Yes.** `ProDocuments` → `/api/profile/resolve` → `profilePrefill` → `TierACalculator`.
5. **Does a lone overtime percentage get a tier identity without evidence?** **Yes — MAJOR.** Assigned to `overtimeTier1Premium`; affects live prefill; can false-conflict with a two-tier payslip.
6. **Can older payslip evidence create a conservative conflict without being treated as current truth?** **Yes — acceptable P1 limitation.** Conflict empties the field; pay-period / annex dates remain on candidates for later P3.
7. **Are contract/payslip disagreements preserved without a silent winner?** **Yes.** `value: null`, all candidates kept.
8. **Are recurring deductions/premiums facts without inventing missing percentages?** **Yes.** Missing percent → excluded `percent_not_printed`; unread amount does not wipe a printed rate.
9. **Are known unknowns actually unknown?** **Yes.** Sat/Sun/holiday, loonheffingskorting, CAO phase, vakantiegeld rate, page/line.
10. **Did P1 stay inside scope?** **Yes.** 13 files, one commit; no Gemini/engine/timeline redesign.
11. **Are tests/typechecks independently green?** **Yes** (see §12). Backend 331/331; frontend 50/50 with Node type-stripping; both typechecks + frontend build OK.
12. **ACCEPTED or NOT ACCEPTED for P2?** **NOT ACCEPTED** — until the lone-OT tier-identity MAJOR is fixed (or owner explicitly redefines approved semantics, which the review task currently forbids treating as tier 1).

---

## 3. FINDINGS

### F1 — MAJOR — Lone overtime percentage assigned false tier-1 identity (live prefill impact)

**Files:** `payroll-profile.ts` `overtimeEvidence` (~L531–556); `pro-profile-prefill.ts` `profilePrefill` maps `overtimeTier1Premium` → `overtime_tier_1_percent`; test `P1.8 #5` encodes the rule.

**Observed rule (source):** within one payslip, lowest distinct genuine overtime percent → tier 1; if only one percent exists, it becomes tier 1.

**Independent reconstruction:**

| Input | `overtimeTier1Premium` | `overtimeTier2Premium` | Live prefill |
|---|---|---|---|
| Payslip A: only 150% | `document_exact` value **50** | `unknown` | `overtime_tier_1_percent = 50` |
| A + B (B: 125% & 150%) | **`conflict`** candidates 50 (A) vs 25 (B), value null | `document_exact` 50 (B only) | tier1 empty; `overtime_tier_2_percent = 50` |

**Answers required by R7:**

1. Source evidence that a single printed OT rate is specifically tier 1? **No.**
2. What the document actually proves? **Only “an overtime premium observed on this payslip” (+50), with unknown tier position.**
3. Can current assignment create a false conflict vs a two-tier payslip? **Yes** (A+B above).
4. Can that false conflict suppress a valid calculator prefill? **Yes** — B’s genuine tier-1 +25 is wiped from prefill.

This matches executor N2, but the review criteria classify it as **MAJOR**, not a non-blocking question. A Payroll Profile may retain the observed premium; it must not claim tier identity the document does not support.

### F2 — NOTE (acceptable P1) — Time-aware old payslip vs current annex/contract rate → conflict

Payslip evidence is not filtered by `asOfDate`. An older payslip rate vs a newer contract/annex rate becomes `hourlyRate: conflict` with `value: null`. Provenance kept: payslip `payPeriod.endDate`, annex `effectiveDate`. Live consumer leaves the calculator field empty — no silent current value. Acceptable under owner “no silent winner”; P3 must later distinguish superseded vs true conflict. Matches executor N1.

### F3 — MEDIUM — `unreliable` (period-type-unknown) payslips omitted from the profile request by the UI

`ProDocuments.processPayslip` sets `payslipBlocked` and does not send the period. Overtime/rate facts on that document are lost for P1 even though the resolver can accept a period with unconfirmed type. Matches executor N4. Not a whole-document audit gate; still a real evidence-loss path until P2.

### F4 — NOTE — Diagnostic panel corrections do not re-resolve the profile

`confirmNeedsConfirmationIssue` / `correctNeedsConfirmationIssue` mutate local diagnostic state only; no second `/api/profile/resolve`. Correct for P1 “panel must not unlock parameters”; means corrected amounts are not profile inputs until P3. Matches N5.

### F5 — NOTE — Executor/design-record process mismatches

- Executor §0 / design record header: “Not pushed” — branch **is** on `origin` at the stated tip (review environment fetched it).
- Executor §14: “P2 can start… No P2 work depends on N1–N3” — **rejected** for N2 under binding review severity.
- Review docs / executor report are **not** in the git commit (attached out-of-band). Fine for review; noted for handoff completeness.

### F6 — NOTE — Old sourcing modules remain in the repo

`pro-parameter-sourcing.ts` still contains `derivePayslipOvertimePercents` / `selectMostRecentReproducedPayslip` and its tests still teach “single percentage is tier 1”. Not live-imported by `ProDocuments`. Dead/legacy; disconnect requirement met. Cleanup deferred is acceptable.

No CRITICAL findings.

---

## 4. P1 EXIT-CRITERIA CHECK

| Essential outcome | Result |
|---|---|
| Canonical backend-owned `PayrollProfile` | **Met** |
| Independent per-parameter evidence states | **Met** |
| Payslip params contribute without global `fullyReproduced` | **Met** |
| Live PRO prefill switched to backend profile | **Met** |
| Overtime tier identity honest to source documents | **Not met** (F1) |

---

## 5. PAYROLL PROFILE RESOLVER REVIEW

- Single pure `resolvePayrollProfile` → every field through `resolveField`.
- States: `document_exact` / `corroborated` / `conflict` / `unknown`; schema also defines unused `user_confirmed` / `user_corrected`.
- Usable set for forward prefill: `USABLE_EVIDENCE_STATES` (backend + mirrored frontend).
- Equality: numeric ε `0.005`, trimmed strings, element-wise arrays. No probabilistic confidence.
- Same value on multiple lines of **one** document stays `document_exact` (test “two lines of one payslip…”).
- Conflict keeps all candidates; `value: null`; reason `sources_disagree` or `timeline_disagreement`.
- Unknown always has a reason code; excluded evidence kept with reason codes.
- No second resolver in React: `pro-profile-prefill.ts` only reads `state`/`value`.

Normalization risk noted: recurring keys use diacritic-stripped lowercased descriptions — distinct printed labels that normalize identically could merge (MEDIUM risk, not demonstrated with a live false merge in this round).

---

## 6. CONTRACT / ANNEX PROVENANCE REVIEW

- Reuses `resolveEffectiveContract` unchanged; does not re-decide timeline winners.
- Timeline disagreement → field `conflict` with values read back from named docs; unique internal `#n` labels restore real filenames even when duplicated (tested).
- Undated annex → excluded `annex_effective_date_missing`.
- Annex overrides only fields it sets; future-dated annex stays in `annexesNotYetInForce` (test #10).
- `/api/contracts/analyze` now returns `canonicalExtraction`; `ProDocuments` stores/sends **only** that for the profile. Display-translated `extraction` is not on the profile path.

---

## 7. PAYSLIP / OVERTIME SEMANTICS REVIEW

**Full multiplier / surcharge / &lt;100% (R7.A):** verified.

- Genuine OT: `category==='overtime' && adds_hours===true && percent` → premium `percent - 100` (150 → +50).
- Surcharge / `adds_hours:false` overtime → `recurringItems.surcharges`, never OT tiers.
- Printed &lt;100% → entire payslip’s OT lines excluded as `percent_semantics_ambiguous` (no negative premium).
- Third distinct percent kept in `overtimeAdditionalTierPremiums`.

**Lone percentage (R7.B):** **fails honesty requirement** — see F1.

**No whole-document gate (R6):** resolver input is `{ period, unreadableFieldPaths }` only. HTTP test proves injecting `fullyReproduced` / discrepancies / needsConfirmation / confirmedIssueKeys leaves the profile identical. Resolver test #4/#12: payslip with real finding + consistency issues still yields OT premiums.

Printed tax/net/payout live only under `calibrationOnly` and are not read by field resolvers (test #11).

---

## 8. LIVE PRO CONSUMER TRACE

Verified path:

`App` → `ProDocuments.submitAll` → document reads → `POST /api/profile/resolve` → `setProfile` → `profilePrefill(profile, badge)` → `TierACalculator` (`tierMode="PRO"`, `key={submitCount}`).

- No import/call of `selectMostRecentReproducedPayslip`, `derivePayslipOvertimePercents`, `isPayslipFullyReproduced` outside comments (source tests + comment-stripped search).
- Prefill copies only usable numeric fields: hourly rate, hours/week, OT threshold, OT tier1/tier2 premiums.
- `conflict` / `unknown` → empty inputs.
- Diagnostic panel cannot change profile prefill via `confirmedIssueKeys` (no re-resolve).

Browser/Gemini end-to-end not run (out of P1 scope).

---

## 9. OLD AUDITOR DISCONNECTION

| Symbol | Status after P1 |
|---|---|
| `isPayslipFullyReproduced` | Exists in `tier-c-shared.ts` + its tests; **not** used for PRO prefill |
| `openNeedsConfirmation` / `confirmedIssueKeys` | Diagnostic panel wording / confirm UI only |
| `selectMostRecentReproducedPayslip` / `ReproducedPayslipCandidate` | Dead for live path; kept in `pro-parameter-sourcing.ts` |
| `derivePayslipOvertimePercents` (frontend) | Dead for live path; semantics moved backend |
| `fullyReproduced` as gate | Not a profile input |
| `/api/contracts/resolve-timeline` | No longer called by `ProDocuments`; route kept |

Old auditor may remain; it no longer determines forward profile fields or calculator prefill. **Met.**

---

## 10. API VALIDATION / TRUST-BOUNDARY REVIEW

`POST /api/profile/resolve`:

- Zod request: `asOfDate`, `documents` capped at 30; roles limited to `contract_base|contract_annex|payslip`.
- Payslip periods validated with shared `isValidPayslipPeriodShape` + `normalizePeriodSigns`.
- Duplicate document indexes rejected; missing extraction / malformed period → `invalid_input`.
- Extra audit keys on documents are not in the schema and do not alter resolution (HTTP test).
- Evidence `sourceType`/`role` for profile fields are **server-produced** (`document` + contract/payslip roles); client cannot forge `user`/`rules` evidence through this boundary.
- No storage, no AI/rules call, no document logging observed in the controller.
- No rate limit (same class as `/resolve-timeline`); not treated as a new CRITICAL issue for a pure recompute endpoint.

No CRITICAL trust-boundary bypass found.

---

## 11. CONTRACTOR CLAIM CHECK

| Claim | Verdict |
|---|---|
| Backend PayrollProfile + per-parameter resolver built | **Verified** |
| Live PRO prefill from profile; old chain disconnected | **Verified** |
| No discrepancy/needsConfirmation/fullyReproduced input | **Verified** |
| `canonicalExtraction` used for profile | **Verified** |
| 13 files, +1770/−154, one commit on stated parent | **Verified** |
| Backend 331/331, FE 50/50, typechecks, FE build green | **Verified** (FE tests need Node type-stripping on this runner; see §12) |
| Engine / timeline / hour-grid / Tier A untouched | **Verified** (not in diff) |
| “Not pushed / not merged / not deployed” | **Stale** — tip is on `origin/p1-payroll-profile`; no merge to `main` observed |
| “Nothing blocks P2”; N2 does not block P2 | **Contradicted** by binding review severity + live prefill impact (F1) |
| N1/N3–N10 characterizations | Largely **accurate** as limitations/notes |

---

## 12. INDEPENDENT TESTS RUN

Environment: Node v22.14.0, `npm ci`, `DATABASE_URL`/`GROQ_API_KEY`/`GEMINI_API_KEY` unset for backend tests.

| Command | Result |
|---|---|
| `npm run test --workspace @nl-payslip/backend` | **331 / 331 pass** (incl. 22 profile + 3 HTTP) |
| `npm run typecheck --workspace @nl-payslip/backend` | exit 0 |
| Frontend tests via `node --experimental-strip-types --test …` (all 6 listed scripts) | **50 / 50 pass** |
| `npm run typecheck --workspace @nl-payslip/frontend` | exit 0 |
| `npm run build --workspace @nl-payslip/frontend` | OK (existing chunk-size warning only) |

Note: plain `npm run test --workspace @nl-payslip/frontend` on Node 22 fails with `ERR_UNKNOWN_FILE_EXTENSION` for `.ts` because the script omits type-stripping. CI workflow uses Node 20 and, notably, **does not run frontend unit tests at all** (only FE typecheck + build). Independent run with strip-types confirms the suite itself is green.

Additional independent reconstruction of R7 A+B case: see F1 table (scripted against built `dist/payroll-engine/payroll-profile.js` + `profilePrefill`).

---

## 13. SCOPE CONTROL

Changed files exactly match the executor list (13). No Gemini prompt/schema, 3-page cap, auto classification, annex-date extraction, conflict UX, full engine feeding, weekend inference, calibration, persistence, or unrelated cleanup in the commit. No `.claude/` / Stage-2v tooling / owner markdown entered the commit.

Hidden scope expansion: **none** found.

---

## 14. WHAT WAS NOT VERIFIED

- Full browser PRO flow with real Gemini document reads (paid call; excluded by task).
- Production deployment / merge state beyond git remotes.
- Whether an owner will later *approve* “lone percent = tier 1” (current binding review text says they have not).
- P3 time-aware supersession design (explicitly out of scope).
- Every recurring-item normalization collision with real multilingual labels.
- Executor report file contents beyond the attached chat copy (file not in the commit).

---

## 15. P2 READINESS

**Not ready to start P2** until F1 is resolved in product code (or the owner issues an explicit written override of the R7 rule — which this review must not invent).

After F1 is fixed, P2 can inherit the otherwise solid profile schema (page/line slots, annex effectiveDate slots, per-field candidates) as described by the executor. N1/N3 remain P3 owner questions and do not by themselves block P2 extraction work.

Suggested minimal fix direction (for the next executor round — **not implemented here**): retain a lone observed overtime premium without writing it into `overtimeTier1Premium` / `overtimeTier2Premium` until tier position is evidenced (e.g. unknown tier slot, or a non-tiered observed-premium field that does not prefill tier-1/tier-2 calculator inputs).

---

## 16. REVIEW HANDOFF

- Review target: `p1-payroll-profile` @ `ff3700eb` (parent `b5847a0`).
- Diff: `git diff b5847a0 ff3700e`.
- Binding docs used from chat attachments (not in commit).
- Blocking finding: **F1 / R7 lone OT tier identity** (MAJOR).
- This report path: `RAPORT-cursor-P1.md` on review branch `cursor/p1-independent-review-d62b`.
- Production code untouched. P2 not started.

**HOLD for auditor review.**

# RAPORT — CURSOR RE-REVIEW R2 F1–F5

**Role:** Independent read-only re-review  
**Project:** Loonto  
**Repository:** `gozimek79-debug/nl-payslip-app`  
**Date:** 2026-10-11  
**Scope:** F1–F5 only. No product edits, no deploy, no R3, no F6, no signed token, no PII redaction.

---

## 1. Executive verdict

F1–F5 are not closed.

The opening-turn weekday backstop, the deterministic unit check, the catalog equality check, and the live-offer check are real and are locked by tests. Three paths still write a weekday-hours or wrong-unit fact, and one of them is live on the public deployment:

- After opening “I don’t know”, an unqualified weekly total is stored as `work.regularWeekdayHours` with no model call.
- A caller-minted `conversation.hoursClarification` plus “yes” / “tak” / “ok” stores that total as weekday hours. Public production did this for 80.
- After a deterministic unit mismatch, a bad model can still write the incompatible field. “40 hours” on the hourly-rate question becomes rate 40 and payout **1022.45**, the original F2 outcome.

R2 must stay open. R3 must not start.

`CURSOR RE-REVIEW R2 F1-F5 — FAIL / CHANGES REQUIRED`

---

## 2. Reviewed SHAs / repository state

| Item | Value |
| --- | --- |
| Previous reviewed R2 | `2868d57cb6498aeb3150b23e6f939f5bd66965a2` |
| Fix under review | `e0e058d4a33826df774d63fc1d6a69d833596027` |
| Parent of the fix | `2868d57cb6498aeb3150b23e6f939f5bd66965a2` (exact) |
| Branch tip `origin/r2-review-fixes-f1-f5` | `e0e058d4a33826df774d63fc1d6a69d833596027` |
| Local snapshot `main` | `b5847a02122b2fcf3383f1a1fabe95920ad45790` |
| Fix contained in local `main` | No |

Review method: the diff and the files were read at `e0e058d` in a detached worktree. Tests and adversarial probes ran against that tree. Product files were not edited. Temporary mutations used to check test strength were restored; the worktree was clean afterwards.

The executor report was not used as proof.

---

## 3. Diff-scope verification

`git diff --name-status 2868d57 e0e058d` is 16 files, +728 / −97:

- `apps/backend-node/package.json` — test script gains `dist/conversation/r2-review-fixes.test.js` only
- `apps/backend-node/src/controllers/conversation.controller.ts` and its test
- conversation modules: `assumption-catalog.ts`, `conversation-agent.ts`, `conversation-turn.ts`, `conversation-types.ts`, `deterministic-interpreter.ts`, `next-question.ts`, `patch-authority.ts`, `scenario-patch.ts`, plus the new `r2-review-fixes.test.ts` and small test updates

No Scenario Core, Tier A formula, document extraction, Gemini, CAO, Memory, or R3 file changed. No merge to `main`. F6, the signed context token, and PII redaction are untouched. The controller test’s happy-path sentence was narrowed to “40 hours Monday to Friday”, which matches the new weekday rule.

---

## 4. F1 code review

The unsafe prompt sentence is gone. `AGENT_SYSTEM_PROMPT` now allows `work.regularWeekdayHours` only for explicit Monday–Friday / weekday wording, and tells the model to put an unqualified total in `statedWeeklyHours` with hint `ambiguous_hours`.

The runtime backstop is `withholdUnstatedWeekdayHours` in `conversation-turn.ts`. It drops `set` / `set_range` / `set_alternatives` / `set_conflict` on `work.regularWeekdayHours` unless one of these is true:

- `statesWeekdaySemantics(message)` (`deterministic-interpreter.ts`)
- the current question field is already `work.regularWeekdayHours`
- the current question is `clarify_hours_composition` and `confirmsWeekdayOnly(message)`

Other ops in the same patch, including the hourly rate, are kept. One `clarify_hours_composition` question is then selected, carrying `statedWeeklyTotal`. An exact “yes” / “tak” commits that total. An exact “no” / “nie” writes nothing and asks for a split (`weekdayOnly: false`).

On a fresh scenario, the listed unqualified, weekend-inclusive, varying, and Polish weekly phrases are withheld even when a scripted model emits weekday 40. Explicit Monday–Friday / “40 weekday hours” / “40 godzin od poniedziałku do piątku” still write 40, source `user`. That part of F1 holds.

The backstop does not cover four other writes, reviewed in sections 5, 6, and 11.

---

## 5. F1 adversarial results

Probes called `runConversationTurn` with scripted or null agents. No network.

| Probe | Result |
| --- | --- |
| Compliant model, “I earn 16.80 an hour and work 40 hours a week” | Rate 16.8 source `user`. Weekday hours absent. One `clarify_hours_composition`, total 40. Evaluation `blocked`. |
| Bad model emits weekday 40 for “40 hours a week”, “I work 40 hours”, “40 godzin tygodniowo”, “40 hours including weekends”, “40 hours, shifts vary”, “40 godzin łącznie z weekendami” | Weekday write withheld (`weekday_hours_withheld`). No split stored. One clarification, total 40. |
| Same bad model, “40 hours Monday to Friday”, “40 weekday hours”, “40 godzin od poniedziałku do piątku” | `regularWeekdayHours = 40`, source `user`. |
| Exact “yes” after a server-issued total of 40 | Commits 40. Clarification dropped once the next field is no longer `work.hours`. |
| Exact “no” | Scenario hours unchanged. Next question `provide_value` / `work.hours` / `hours_include_other_categories`. |
| Bad model also emits `saturdayHours = 8` for “40 hours a week” | Weekday op withheld. **Saturday 8 is stored, source `user`.** Next question becomes the hourly rate, so the hours-composition question is gone. |
| Bad model emits `overtimeHours = 5` for “40 hours, shifts vary” | **Overtime 5 is stored, source `user`.** Same loss of the composition question. |
| Bad model, “40 hours but not weekdays”, “I do not work weekdays, 40 hours”, “40 hours, no weekdays” | `statesWeekdaySemantics` is true because the word “weekdays” matches. **Weekday 40 is stored.** |

The opening-phrase backstop works. It is not a general “do not invent an hours split” guard, and a negated weekday word counts as weekday evidence.

---

## 6. `hoursClarification` trust-boundary review

The public schema accepts it (`conversation.controller.ts`):

`hoursClarification: { statedWeeklyTotal?: number (0..168), weekdayOnly?: false }`

`cleanClarification` keeps a finite total in range and `weekdayOnly: false`. The comment says the object can only steer which question is asked. That is false. `selectNextQuestion` turns a non-empty clarification into `clarify_hours_composition` whenever the open requirement is still `work.hours`, and `interpretDeterministically` writes `statedWeeklyTotal` on an exact yes-word (`yes`, `tak`, `ok`, `sure`, `fine`, `accept`, and the rest of the YES list).

`pendingQuestion` in the same digest is ignored. The server recomputes the question. `hoursClarification.statedWeeklyTotal` is the value that gets written.

Independent probes, null agent, fresh scenario:

| Request | `regularWeekdayHours` |
| --- | --- |
| `hoursClarification: { statedWeeklyTotal: 80 }`, message `yes` | **80, source `user`** |
| same, total 40, message `yes` | **40, source `user`** |
| total 80, message `tak` | **80, source `user`** |
| total 80, message `ok` | **80, source `user`** |
| Replay of total 40 onto a different scenario that has a rate and no hours, message `yes` | **40, source `user`** |
| Server issued 40, client changes the echoed total to 80, message `yes` | **80, source `user`** |
| `{ statedWeeklyTotal: 80, weekdayOnly: false }`, message `yes` | No write. Question becomes the split prompt and echoes 80. |
| `{}` or a non-numeric total | No write. Opening question kind still becomes `clarify_hours_composition`. |
| Complete ready scenario, stale total 80, message `yes` | Hours stay 40. Payout unchanged (576.63). The stale object does not overwrite hours once `work.hours` is no longer the requirement. |

A client can already place `source: "user"` values in the scenario body (probe: incoming weekday 80 is kept). That is the existing stateless user-fact model. This path is different: the server treats a one-word reply as confirmation of a number that is not in the message and was not issued by the server. The same commit refuses to trust `pendingQuestion`. This new field is write authority.

Public production, `POST /api/scenario/turn` on `https://nl-payslip-app.vercel.app`, no model (`agentStatus: "not_needed"`):

`conversation.hoursClarification.statedWeeklyTotal = 80` and message `yes` returned `work.regularWeekdayHours = { source: "user", state: "known", value: 80 }`.

**Answer to the mandatory question: yes. A forged `conversation.hoursClarification` plus “yes” commits weekday hours with no genuine ambiguous-hours turn.**

Minimum fix: do not commit `statedWeeklyTotal` from the request. Exact yes/tak/ok must not write hours from this field. Display of a prior total can remain only if it cannot be applied. A signed digest would bind an honest echo; that design stays out of scope here, and until it exists the unsigned total must not be the written value.

---

## 7. F2 code review

`parseNumericAnswer` classifies units. It does not strip them. `unitsFitField` allows a number only when every unit fits the field:

- hours: `hours`, `per_week`
- `eur_per_hour`: `money`, `rate`
- percent / premium: `percent`

A mismatch makes `interpretDeterministically` return null. The turn then calls the model once, if one is configured. There is no later check that the model’s `set` respects the units just parsed. The F1 withhold looks only at `work.regularWeekdayHours`.

Deterministic results (null agent, scenario unchanged, no payout):

- Rate question: “16.80”, “€16.80”, “16.80 per hour”, “16,80 € za godzinę” → 16.8. “40 hours”, “40 godzin”, “50%”, “16.80 a week” → not applied.
- Hours question (`regularWeekdayHours` already unknown): “40”, “40 hours”, “40 godzin”, “40 hours a week” → 40. “50%”, “€16.80” → not applied.
- Sunday-premium question: “50”, “50%”, “50 procent” → 50. “50 hours”, “€50” → not applied.

Polish hour words that the parser knows (`godzin`, `tygodniowo`) are classified. “40 hours a week” is `{40, hours + per_week}`, which fits an hours field. That is why the post-F5 path in section 11 commits it deterministically.

---

## 8. F2 bad-model / whole-pipeline result

Setup: current question is the hourly rate (ready scenario with `pay` cleared). User message “40 hours”. Deterministic parser refuses. Scripted model emits `set pay.hourlyRate = 40`.

Result: **status `updated`, rate 40 source `user`, evaluation `computed`, payout 1022.45.** One model call. No patch note. The weekday field was already 40, so this is the rate write.

Same pattern:

| Current question | Message | Bad model op | Result |
| --- | --- | --- | --- |
| Weekday hours | `€16.80` | `set work.regularWeekdayHours = 16.8` | Hours become 16.8. Payout **267.22**. The F1 exemption allows it because the current field is `work.regularWeekdayHours`. |
| Sunday premium | `50 hours` | `set pay.sundayPremiumPercent = 50` | Premium becomes 50. Payout **661.86**. |

The only remaining defense on this path is the model. That is not acceptable before R3. The server has already classified the units as incompatible and then discards that fact. The focused tests script the model as `unclear`, so they stay green while this write succeeds.

Minimum fix: when `parseNumericAnswer` yields units that do not fit the current question’s field, drop a model `set` of that field before `applyScenarioPatch`. “40 hours” on the rate question must leave the rate unset.

---

## 9. F3 review

`findForgedAssumptions` runs before interpretation, the model, and evaluation. A `loonto_assumption` node must `canonicalJson`-equal `assumptionNode` for that catalog field. Otherwise the turn is `rejected` with `untrusted_loonto_assumption` and `untrusted_scenario`. The node is not rewritten to `user`.

Catalog: Saturday 50, Sunday 100, holiday 100, deductions `estimate`, tax-credit alternatives `['applied', 'not_applied']`.

The 23-test file plus a production call cover the required probes:

1. Hourly rate 99 → `not_in_catalog`. Production: `agentStatus: "not_needed"`, issue on `pay.hourlyRate`, scenario still `loonto_assumption` / 99, `evaluation: null`.
2. Saturday 25 → `not_canonical`.
3–7. Canonical Saturday, Sunday, holiday, deductions estimate, tax-credit alternatives → accepted. Production “yes” on a live Saturday offer wrote the catalog 50 and computed.
8. Same value, wrong shape (range 50–50, string `"50"`, tax options reversed, tax as known, deductions `enter`) → rejected.
9. Extra `ref` → rejected.
10. Rejection is before the model (scripted agent `calls === 0`; production `not_needed`).

Conflict candidates and `requestedConcepts` carrying `loonto_assumption` are rejected. A parent `source` on a `conflict` node is not inspected; candidates are. Evaluation uses candidate sources, so this is a schema gap with no laundering path found.

F3 is closed. The fix is not a downgrade to `user`.

---

## 10. F4 review

`authorizePatch` accepts `accept_assumption` only when `guard.offeredAssumption === field`. The turn sets that guard from the deterministic current question, and only when its kind is `offer_assumption`. Client `pendingQuestion` is not read.

| Probe | Result |
| --- | --- |
| `provide_value` + model accept, “use your own best guess” | `assumption_not_offered`. Scenario byte-identical. Saturday premium absent. |
| `correct_value` + model accept | Rejected. |
| `resolve_conflict` + model accept | Rejected. |
| Live Saturday offer + accept Saturday | Catalog 50, source `loonto_assumption`. |
| Live Saturday offer + accept Sunday | `assumption_not_offered`. Sunday not written. |
| Stale client `pendingQuestion` claiming a Sunday offer | Rejected. Server still offers Saturday. |
| Prompt injection + bad model accept while the question is not an offer | Rejected. |
| Ops `[set rate 99, accept Sunday]` while Saturday is offered | Whole patch rejected. Rate stays 16.8. |
| Ops `[accept Saturday, set travel allowance]` on a live Saturday offer | Accept applies. One bad op is what rejects the patch; a second legal op on a matching offer applies with it. |

F4 is closed.

---

## 11. F5 review

Opening “I don’t know” / “nie wiem” / “Nie mam pojęcia.” / “no idea” does not call the model, does not write 0, and does not insert `loonto_assumption`. It writes:

`work.regularWeekdayHours = { state: "unknown" }`

with no `source` and no number. The next question is `work.regularWeekdayHours`, reason `user_does_not_know`, `hoursScope: "weekday_regular_only"`, fallbacks `give_range` and `split_hours`. A repeat is `unchanged` because the identical unknown write is filtered. A later range of 30–40 is stored when that question is still the weekday question. Production matches the first step for both “I don’t know” and “nie wiem” (`agentStatus: "not_needed"`).

**The unknown node is a category decision.** R1 already treats `{ state: "unknown" }` on `work.regularWeekdayHours` as relevance `unknown`, so the requirement becomes that field instead of virtual `work.hours` (`scenario-validate.ts` `collectRequirements`, unchanged by this diff). The user’s “I don’t know” was about opening hours, not a confirmation that Monday–Friday regular hours are the right bucket.

Multi-turn, local, starting from an empty scenario:

| Step | What was stored |
| --- | --- |
| “I don’t know” (no model) | `regularWeekdayHours` unknown. Next field is that weekday question. |
| “40 hours a week” (no model) | **`regularWeekdayHours = 40`, source `user`.** Deterministic, because `per_week` fits `hours`. The F1 backstop never runs. |
| Same sentence with a bad model ready | Model **not called** (`calls === 0`). Same write. |
| “40 godzin tygodniowo” (no model) | Same write, 40. |
| “40 hours including weekends” (bad model emits weekday 40) | **40 stored.** Backstop skipped because `current.field === "work.regularWeekdayHours"`. |
| “40 hours, shifts vary” (same bad model) | **40 stored.** Same exemption. |
| “weekends too” after the 40 is in (bad model emits Saturday 8 and weekday 32) | Weekday 32 withheld (the question is now the rate). **Saturday 8 stored.** |
| “I don’t know” again | Sets the **rate** unknown. The weekday 40 remains. |
| “between 30 and 40” aimed at weekday hours | Withheld, because the current question is no longer weekday hours. The misclassified 40 remains. |

Bare “40” and “40 hours” after the weekday question also store 40. Those are plausible answers to a question that really is about weekday hours. The failure is that F5 forces that question, and the weekly-total / weekend / varying sentences then take the same path.

**Answer to the mandatory question: yes. `regularWeekdayHours = unknown` classifies the open hours gap as weekday regular hours. The next unqualified weekly total is then stored as that category, including with no model.**

The dead-end (same question, no fallback, no progress) is gone. The semantic invariant is not met.

Minimum fix: opening `work.hours` “I don’t know” must not `set_unknown` on `work.regularWeekdayHours`. Progress with the existing `work.hours` split/range fallbacks, or with another marker that does not retarget R1 onto the weekday field. Independently, `per_week` must not be enough to set `work.regularWeekdayHours`, and the backstop exemption for the weekday question must still withhold unqualified weekly totals, weekend-inclusive phrases, and “shifts vary”.

---

## 12. Authority-shell regression

Preserved in this diff:

- Self-declared verified sources are rejected before the model. Production: `source: "document"` → `untrusted_provenance_in_scenario`, `agentStatus: "not_needed"`, `evaluation: null`.
- `loonto_assumption` is not minted and is not downgraded to `user` (section 9).
- Patch application stays atomic. One illegal `accept_assumption` rejects the whole patch, including a paired rate write (section 10).
- Verified values still cannot be overwritten by an ordinary `set` (`patch-authority.ts` `cannot_override_verified` / `cannot_erase_verified`, unchanged rules; provenance tests still pass).
- The turn still calculates only through `evaluateScenario`. Conversation files do not import Tier A or call `/api/tier-a`. The boundary test passes.
- One provider call, `maxRetries: 0`, invalid output is not repaired (`conversation-agent.ts`).
- The next question is `selectNextQuestion` from the server evaluation. Client `pendingQuestion` does not choose it.
- `/turn` response keys on production match the public allow-list. No `engineInput`, `engineResult`, `runs`, or prompt text. Empty `/evaluate` is `blocked` with requirements and `taxRatesSource: "database"`, no engine payload.
- Limiter remains 30 per 300 seconds, `onUnknown: "deny"` (`scenario-config.ts`, unchanged).

The new digest field in section 6 is a new write path beside that shell. It does not weaken the verified-source or assumption checks.

---

## 13. Test-quality review

Backend at `e0e058d`: **653 / 653 pass**, including build.  
Frontend: **117 / 117 pass** under `node --experimental-strip-types --test`. The package script without that flag fails on Node 22.14 (`ERR_UNKNOWN_FILE_EXTENSION` for `.ts`). Frontend sources are outside this diff.  
Focused file `r2-review-fixes.test.ts`: **23 tests**, and they fail when the guarded behavior is removed:

| Mutation (restored afterwards) | Focused result |
| --- | --- |
| Unsafe “IS work.regularWeekdayHours” sentence restored | 1 fail: the prompt string test. The behavioral F1 tests still pass, because the backstop is still there. |
| `withholdUnstatedWeekdayHours` returns the patch unchanged | 4 F1 tests fail. |
| Unit mismatch treated as a fit | 4 F2 tests fail. |
| `findForgedAssumptions` returns `[]` | 2 F3 rejection tests fail. Canonical-accept tests stay green, which is correct. |
| Offer check inverted | 5 F4 tests fail. |
| Opening don’t-know returns null | 3 F5 tests fail. |

The 23 tests do not fail for the holes in this review:

- No case sends a forged `hoursClarification`.
- F2’s model double is scripted as `unclear`, so the 1022.45 path is untested.
- F5 asserts that don’t-know **must** write `regularWeekdayHours: { state: "unknown" }` and then asks that field. A follow-up “40 hours a week” is absent, so the tests lock the classification in.
- No case covers a bad model inventing Saturday or overtime, or negated “weekdays”.

Counts are real. They do not hold M1–M4.

---

## 14. Production verification

Expected deployment id `dpl_CojsBbpHBsjc7BEKwjZ5Rq74FhXG` was **not** visible. No Vercel token was available. GitHub deployment `6987099046` is environment **Preview**, SHA exactly `e0e058d4a33826df774d63fc1d6a69d833596027`, state `success`, URL `https://nl-payslip-aeqql3uqv-gregor-s-projects2.vercel.app`. That URL returns HTTP 302 to Vercel SSO, so the six behavioral checks could not be run there.

The public host `https://nl-payslip-app.vercel.app` does expose `/api/scenario/turn` and `/api/scenario/evaluate`. `/api/health` returns `commit: ""` and `deploymentUrl: "nl-payslip-blszh70ym-gregor-s-projects2.vercel.app"`, so the SHA of that host was not proved. Behavior matches this fix, and every call below was chosen so it would not reach the model (`agentStatus: "not_needed"` or evaluate-only):

| Check | Result |
| --- | --- |
| Empty scenario `/evaluate` | 200, `blocked`, requirements start with `work.hours`. No engine keys. |
| `/turn` exists | 400 on `{}` for missing `message` / `locale`. |
| Forged hourly `loonto_assumption` 99 | Rejected, `untrusted_loonto_assumption`, no evaluation, source not rewritten. |
| Opening “I don’t know” and “nie wiem” | Progress to `work.regularWeekdayHours` with `give_range` / `split_hours`. Unknown node, not 0. |
| Response keys | Public allow-list only. |
| “16.80” while the rate is the open question | Rate 16.8, source `user`, no model. |
| Forged `hoursClarification` 80 + “yes” | **Writes weekday 80, source `user`.** |
| Self-declared `document` rate | `untrusted_provenance_in_scenario`, no model. |
| Canonical Saturday offer + “yes” | Assumption 50, evaluation `computed`, public figure keys only. |

“40 hours” against a live rate question was not sent, because production would call the model. That case is the local probe in section 8.

---

## 15. Answers to the 16 CTO questions

1. **Is F1 fully closed?** No. The opening listed phrases are withheld. Unqualified totals still become weekday hours after F5, via a forged clarification, via the weekday-question exemption, and via a negated “weekdays” match. A bad model can also store a Saturday or overtime split.
2. **Can any path still map an unqualified weekly total to weekday hours without explicit confirmation?** Yes. Empty scenario, “I don’t know”, then “40 hours a week”, with no model, stores weekday 40.
3. **Can forged `conversation.hoursClarification` create a false weekday-hours write?** Yes. Local and public production. “yes” / “tak” / “ok” commit the minted total while `work.hours` is the open requirement.
4. **Is F2 fully closed across the whole pipeline, including a bad LLM after deterministic unit mismatch?** No. The deterministic shortcut is closed. The model path is not.
5. **Can “40 hours” still become hourly rate 40 by any route?** Yes, when the rate is the current question and the model emits that set. Local payout 1022.45. The deterministic route does not do it.
6. **Is F3 fully closed?** Yes.
7. **Can a caller still mint a Loonto assumption?** No. Non-catalog and non-canonical nodes are rejected and left unchanged. They are not downgraded to `user`.
8. **Is F4 fully closed?** Yes.
9. **Can a model accept an assumption the server did not offer?** No. Wrong field, stale `pendingQuestion`, and non-offer question kinds are `assumption_not_offered`, and the scenario stays byte-identical.
10. **Is F5 fully closed?** No. The dead-end is gone. Writing `regularWeekdayHours = unknown` selects the weekday category, and the next weekly total is stored there.
11. **Does `regularWeekdayHours = unknown` accidentally classify the user’s weekly hours as weekday?** Yes. The node has no number and no source, and R1’s requirement switches from `work.hours` to `work.regularWeekdayHours`. The following “40 hours a week” is then a user weekday fact.
12. **Does repeated “I don’t know” progress safely?** The second “nie wiem” on the same unknown weekday node is `unchanged` and still offers `give_range` / `split_hours`. It does not loop on an empty fallback. It is not safe once an unqualified total has been classified, because a later “I don’t know” moves on to the rate and leaves the weekday fact in place.
13. **Did any F1–F5 fix weaken provenance, atomic apply, or Tier A authority?** No. Verified sources, catalog assumptions, whole-patch rejection, Scenario Core evaluation, the public projection, the single model call, and the 30/300 fail-closed limiter still hold.
14. **Did the fixes introduce any new BLOCKER, CRITICAL, or MAJOR issue?** Yes. MAJOR M1, M2, M3, and M4 below. No BLOCKER or CRITICAL.
15. **Are the focused tests strong enough to hold F1–F5?** They hold the guards they encode, and they fail when those guards are removed. They do not hold M1–M4. F5’s tests require the unsafe unknown write.
16. **Is R2 ready to close and unblock R3?** No.

---

## 16. Findings table

| ID | Severity | Finding |
| --- | --- | --- |
| M1 | MAJOR | Opening “I don’t know” writes `work.regularWeekdayHours = unknown`, and the next unqualified weekly total is stored as weekday hours with no model and no confirmation. |
| M2 | MAJOR | Caller-minted `conversation.hoursClarification.statedWeeklyTotal` plus “yes” / “tak” / “ok” writes that total as weekday hours. Confirmed on public production for 80. |
| M3 | MAJOR | After a deterministic unit mismatch, a bad model can write the current field. “40 hours” becomes hourly rate 40, payout 1022.45. |
| M4 | MAJOR | The weekday backstop does not stop other hour fields. A bad model stores Saturday 8 for “40 hours a week”, or overtime 5 for “shifts vary”, and the composition question disappears. |
| m1 | MINOR | `statesWeekdaySemantics` treats “not weekdays” / “no weekdays” as affirmative, so a bad model can store weekday hours for an explicit denial. |
| m2 | MINOR | A malformed or empty `hoursClarification` still switches the opening question to `clarify_hours_composition` without a total. |
| n1 | NIT | A withheld `set_range` uses the high endpoint as `statedWeeklyTotal`, so “between 36 and 40” is clarified as 40. |

No BLOCKER. No CRITICAL.

---

## 17. Required fixes

Do not treat this section as an implementation. It is the minimum correction for each MAJOR.

**M1.** `interpretDeterministically` (`deterministic-interpreter.ts`), opening `current.field === "work.hours"` and `isDontKnow`: stop emitting `set_unknown` on `work.regularWeekdayHours`. Keep the turn on virtual `work.hours`, which already has `split_hours` / `give_range`. In the same function, stop treating `per_week` as sufficient for `work.regularWeekdayHours`. In `withholdUnstatedWeekdayHours` (`conversation-turn.ts`), remove the blanket exemption `current?.field === "work.regularWeekdayHours"` for messages that are an unqualified weekly total, that include weekends, or that say shifts vary. Bare “40” / “40 hours” on a real weekday question can still be stored.

Reproduction: empty scenario, “I don’t know”, then “40 hours a week”, agent `null`. Today the second turn’s `work.regularWeekdayHours.value` is 40 and `agentStatus` is `not_needed`.

Consequence: a worker who does not know their hours, then states a weekly total, is calculated as Monday–Friday regular hours.

**M2.** `interpretDeterministically`, the `clarify_hours_composition` yes-branch: stop using `current.prompt.params.statedWeeklyTotal` from request-carried `hoursClarification` as the `set` value. Exact yes/tak/ok must not write hours from that field. `cleanClarification` (`conversation-turn.ts`) may keep steering a question only if the number cannot be committed. Signing the digest is the durable binding and stays a separate design; until that binding exists, the unsigned number must not be applied.

Reproduction: `{ message: "yes", locale: "en", conversation: { hoursClarification: { statedWeeklyTotal: 80 } } }` on an empty scenario. Today, and on public production, weekday hours become 80, source `user`, `agentStatus: "not_needed"`.

Consequence: a stale, replayed, or edited total becomes a user fact and later a Tier A input, from a reply that contains no number.

**M3.** In `runConversationTurn`, after the model returns: if `parseNumericAnswer` produced units that `unitsFitField` rejects for the current question’s field, remove model ops that `set` that field. Apply this before `applyScenarioPatch`.

Reproduction: rate question, message “40 hours”, model op `set pay.hourlyRate = 40`. Today the scenario rate is 40 and payout is 1022.45.

Consequence: the original F2 mis-pay survives any bad completion. The server already knew the units conflicted.

**M4.** Extend `withholdUnstatedWeekdayHours` so `set` of `work.saturdayHours`, `work.sundayHours`, `work.publicHolidayHours`, and `work.overtimeHours` is dropped unless the message names that category. Keep unrelated ops such as the hourly rate.

Reproduction: fresh scenario, message “40 hours a week”, model op `set work.saturdayHours = 8`. Today Saturday 8 is stored and the next question is the hourly rate.

Consequence: an unqualified total is silently classified into a premium category.

**m1.** `statesWeekdaySemantics` should require affirmative weekday wording and ignore matches under `not` / `no` / `nie` / `bez`.

**Tests that must be added with those fixes:** forged clarification plus yes; bad model after an F2 unit mismatch asserting payout is absent; don’t-know then “40 hours a week” / “including weekends” / “shifts vary” asserting weekday hours stay unset; bad model inventing Saturday hours on an unqualified total.

---

## 18. Final recommendation on R2 closure / R3 readiness

Do not close R2. Do not start R3.

F3 and F4 are closed. The deterministic half of F2 is closed. The opening-phrase half of F1 is closed. F5 removes the empty-fallback dead-end and, by the way it does that, reopens F1. The new `hoursClarification` field is a trust-boundary hole, and it is live on the public turn route. The unit-mismatch fallthrough still pays the original wrong rate when the model complies with the bug.

The authority shell around verified facts, catalog assumptions, atomic patches, and Tier A is intact. That is not enough to make this commit the backend foundation for R3.

`CURSOR RE-REVIEW R2 F1-F5 — FAIL / CHANGES REQUIRED`

HOLD FOR CTO REVIEW

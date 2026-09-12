# Conventions

Standing rules for this repo. Not comments in one file — if a rule matters
across rounds, it belongs here, or it gets lost the way the rule below did.

## User-facing strings cross the API boundary as data, never as prose

**The rule:** anything a human reads in the UI - an error message, a
provenance label, a warning, a computed line's description - is either:

1. **A translated string resolved from `apps/frontend-react/src/translations.ts`**
   via the active `lang`, or
2. **Structured data** (an error/warning *code* plus the numeric or string
   *parameters* needed to build a sentence) that the frontend turns into a
   sentence in the interface language.

A backend controller or engine module must never assemble a finished,
language-specific sentence and send it as the thing to display. If a string
needs to vary by `lang`, the backend has no business writing it.

**Why this is a rule and not a preference:** it already happened twice.

- Round "language regression" (audit BJ1): Tier A's `copy` object was
  literally named `pl` and contained Dutch text - translation existed as a
  data structure and was false. The component discarded its own `lang` prop
  entirely.
- Same round, one layer down: `tier-a.ts` was assembling whole Dutch
  sentences with provenance baked in (`"STIPP-pensioen (schatting, <url>)"`)
  and shipping them as `description` fields, and `checkTierASanity` was
  shipping a fully-formatted Dutch `message` string per warning. The
  frontend had resorted to `.split(' (')[0]` to tear the sentence back
  apart - which is what a UI layer looks like when the string it received
  was never structured for translation in the first place.

The fix in both cases was the same: push the sentence-building down to
where `lang` is known (the frontend), and have the backend supply only
`code` + numeric/string parameters. See `TierASanityWarning` and
`TierASectorPremiumEstimate.known_terms` in
`apps/backend-node/src/payroll-engine/tier-a.ts` for the pattern in place.

**Applies to:** every controller, not just Tier A's. Confirmed still present
in `calculator.controller.ts` and `tier-a.controller.ts`'s own top-level
`400`/`503` error bodies (`'Nieprawidłowe dane wejściowe.'`, etc.) - flagged,
scheduled for after Tier C ships (doing it before Tier C's own error paths
exist means doing it twice), not fixed as part of this note.

**Applies to Tier C from the start**, not as a retrofit: any new
error/warning/discrepancy-message code written for Tier C follows this
pattern natively - `code` + parameters out of the backend, sentence built in
`translations.ts`.

### Dutch payslip-line terms are the one deliberate exception

A line's Dutch/as-printed TERM (e.g. `"StiPP-pensioenpremie"`, or - once
Tier C reads real documents - the exact string printed on that payslip) is
not translated and is not an exception that needs justifying each time:
it's data the user is meant to visually match against their own document,
in whichever interface language surrounds it. See `PreTaxDeduction.description`
in `apps/backend-node/src/payroll-engine/payslip-model.ts` and BK3/BK4 in the
architecture spec for why this field is deliberately NOT run through
translation, and carries either the canonical term (Tier A) or the
as-printed term (Tiers B/C) depending on which tier populated it.

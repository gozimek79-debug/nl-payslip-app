/**
 * Stage 2s (audit v51, §2s.2), carried into 2t: one canonical schema definition, mirroring
 * `TIER_C_SYSTEM_PROMPT`'s own JSON shape (ocr-client.ts) and `TierCExtraction` (tier-c.ts)
 * field-for-field - built once here, then adapted into Gemini's own wire format
 * (`toGeminiResponseSchema`). Stage 2t (§2t.2) retired the Mistral-side adapter
 * (`toMistralAnnotationSchema`) and the per-page merge (`mergeRawExtractionPages`) along with Mistral
 * itself - Gemini's own `generateContent` takes every page in one call (confirmed live, 2s.1b), so no
 * merge is needed for the one reader that remains.
 */

export type SchemaNode =
  | { readonly kind: 'string'; readonly nullable?: boolean }
  | { readonly kind: 'number'; readonly nullable?: boolean }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'array'; readonly items: SchemaNode }
  | { readonly kind: 'object'; readonly properties: Readonly<Record<string, SchemaNode>>; readonly required: readonly string[] };

const str = (nullable = false): SchemaNode => ({ kind: 'string', nullable });
const num = (nullable = false): SchemaNode => ({ kind: 'number', nullable });
const bool = (): SchemaNode => ({ kind: 'boolean' });
const arr = (items: SchemaNode): SchemaNode => ({ kind: 'array', items });
const obj = (properties: Record<string, SchemaNode>, required: string[]): SchemaNode => ({ kind: 'object', properties, required });

const hourLineSchema = obj(
  {
    description: str(),
    hours: num(true),
    rate: num(true),
    percent: num(true),
    amount: num(),
    category: str(),
    tax_treatment: str(),
    adds_hours: bool(),
    employer_index: num(),
  },
  ['description', 'amount', 'category', 'tax_treatment', 'adds_hours', 'employer_index'],
);

const preTaxDeductionLineSchema = obj(
  { description: str(), amount: num(true), category: str(), base: num(true), percent: num(true) },
  ['description', 'amount', 'category'],
);

const postTaxDeductionLineSchema = obj({ description: str(), amount: num(true), category: str(), percent: num(true) }, ['description', 'amount', 'category']);

const netLineSchema = obj({ description: str(), amount: num(), category: str() }, ['description', 'amount', 'category']);

const payoutAdjustmentLineSchema = obj({ description: str(), amount: num() }, ['description', 'amount']);

const reservationLineSchema = obj({ type: str(), accrued: num(), paid_out: num() }, ['type', 'accrued', 'paid_out']);

/** The full TierCExtraction shape, canonical form. Field order matches `TIER_C_SYSTEM_PROMPT`'s own
 * documented JSON shape and `tier-c.ts`'s `TierCExtraction` interface. */
export const TIER_C_EXTRACTION_SCHEMA: SchemaNode = obj(
  {
    period_label: str(true),
    period_end_date: str(true),
    payment_date: str(true),
    period_type: str(true),
    is_correction: bool(),
    version: num(),
    employer_names: arr(str()),
    hirer_name: str(true),
    hours_per_week: num(true),
    minimum_wage_printed: num(true),
    bijzonder_tarief_printed_percent: num(true),
    bijzonder_tarief_jaarloon: num(true),
    hour_lines: arr(hourLineSchema),
    pre_tax_deduction_lines: arr(preTaxDeductionLineSchema),
    post_tax_deduction_lines: arr(postTaxDeductionLineSchema),
    et_exchange_amount: num(true),
    et_reimbursement_lines: arr(netLineSchema),
    net_lines: arr(netLineSchema),
    payout_adjustment_lines: arr(payoutAdjustmentLineSchema),
    reservation_lines: arr(reservationLineSchema),
    printed_table_tax: num(true),
    printed_bt_tax: num(true),
    printed_algemene_heffingskorting: num(true),
    printed_arbeidskorting: num(true),
    printed_gross_total: num(true),
    printed_loon_voor_heffingen: num(true),
    printed_taxable_base_normal: num(true),
    printed_taxable_base_special: num(true),
    reported_total_net: num(true),
    reported_net_paid: num(true),
    printed_table_tax_label: str(true),
    printed_bt_tax_label: str(true),
    printed_algemene_heffingskorting_label: str(true),
    printed_arbeidskorting_label: str(true),
    printed_net_label: str(true),
    printed_payout_label: str(true),
  },
  [
    'period_label', 'period_end_date', 'payment_date', 'period_type', 'is_correction', 'version',
    'employer_names', 'hirer_name', 'hours_per_week', 'minimum_wage_printed',
    'bijzonder_tarief_printed_percent', 'bijzonder_tarief_jaarloon', 'hour_lines',
    'pre_tax_deduction_lines', 'post_tax_deduction_lines', 'et_exchange_amount',
    'et_reimbursement_lines', 'net_lines', 'payout_adjustment_lines', 'reservation_lines',
    'printed_table_tax', 'printed_bt_tax', 'printed_algemene_heffingskorting', 'printed_arbeidskorting',
    'printed_gross_total', 'printed_loon_voor_heffingen', 'printed_taxable_base_normal',
    'printed_taxable_base_special', 'reported_total_net', 'reported_net_paid',
    'printed_table_tax_label', 'printed_bt_tax_label', 'printed_algemene_heffingskorting_label',
    'printed_arbeidskorting_label', 'printed_net_label', 'printed_payout_label',
  ],
);

/** Gemini's `generationConfig.responseSchema` (§2s.1b, confirmed live): UPPERCASE type names, nullable
 * expressed as its own `nullable: true` boolean field - a genuinely different wire shape from
 * Mistral's, confirmed by one live call each rather than assumed identical because both are "a JSON
 * schema". */
export function toGeminiResponseSchema(node: SchemaNode): unknown {
  switch (node.kind) {
    case 'string':
      return node.nullable ? { type: 'STRING', nullable: true } : { type: 'STRING' };
    case 'number':
      return node.nullable ? { type: 'NUMBER', nullable: true } : { type: 'NUMBER' };
    case 'boolean':
      return { type: 'BOOLEAN' };
    case 'array':
      return { type: 'ARRAY', items: toGeminiResponseSchema(node.items) };
    case 'object':
      return {
        type: 'OBJECT',
        properties: Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, toGeminiResponseSchema(v)])),
        required: [...node.required],
      };
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR3BStore, panelRows, resultReasons, type R3BStore, type ThreadMessage } from './r3b-flow.ts';
import { describeTurn, readReportLines } from './r3b-describe.ts';
import { R3B_COPY } from './r3b-copy.ts';
import { suggestionsFor, type TurnResultView } from './r3b-turn.ts';
import { fixtures, harness, pdf, readOk } from './r3b-test-support.ts';

/**
 * R3-B acceptance cases 1-5 through the real interface state machine. The network is the RECORDED real backend
 * (reader routes mocked by fixture batches; Payroll Profile and R2 recorded from the real code and re-checked by the
 * backend suite): every request the interface sends must be byte-for-byte the recorded one. No paid call.
 */

const PL = R3B_COPY.pl;
const turnsOf = (s: ReturnType<R3BStore['getState']>) => s.messages.filter((m): m is ThreadMessage & { block: { kind: 'turn' } } => m.block.kind === 'turn');
const lastTurn = (store: R3BStore) => turnsOf(store.getState()).at(-1)?.block as Extract<ThreadMessage['block'], { kind: 'turn' }>;
const asked = (store: R3BStore) => turnsOf(store.getState()).map((m) => (m.block as { result: TurnResultView }).result.nextQuestion?.field ?? null);

function assertCleanRequests(bodies: Array<Record<string, unknown>>) {
  for (const body of bodies) {
    const json = JSON.stringify(body);
    assert.ok(!json.includes('"source":"document"'), 'never a self-declared document source');
    assert.ok(!/IGNORE PREVIOUS|factBatches|Uurloon|Uren normaal/.test(json), 'no document content in a conversation turn');
    assert.deepEqual(Object.keys(body).filter((k) => !['scenario', 'message', 'locale', 'conversation'].includes(k)), [], 'only the public turn fields');
  }
}

test('R3-B case 1: payslip EUR 16.80 - read only on the explicit action, short summary with sources, the rate is never asked again, no amount', async () => {
  const h = harness({ reads: { 'loonstrook-synthetic.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case1_goal_model });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('loonstrook-synthetic.pdf')], 'payslip');
  assert.equal(h.readCalls.length + h.resolveBodies.length + h.turnBodies.length, 0, 'selecting a file sends nothing');
  assert.equal(store.getState().docs[0]?.status, 'selected');

  await store.read();
  assert.deepEqual(h.readCalls, [{ name: 'loonstrook-synthetic.pdf', kind: 'payslip' }]);
  const s1 = store.getState();
  assert.equal(s1.phase, 'goal');
  assert.equal(s1.docs[0]?.status, 'read');
  const rate = s1.knowledge?.facts.find((f) => f.path === 'employment.hourlyRate');
  assert.equal(rate?.status, 'document_reading');
  assert.equal(rate?.value, 16.8);
  assert.deepEqual([rate?.sources[0]?.role, rate?.sources[0]?.documentId, rate?.sources[0]?.page, rate?.sources[0]?.period?.start, rate?.sources[0]?.period?.end], ['payslip', 'doc-1', 1, '2026-08-10', '2026-08-16']);
  assert.equal(rate?.sources[0]?.rawValue, 'Uren normaal 40,00 16,80 672,00');
  assert.deepEqual(s1.knowledge?.deferrableFields, ['pay.hourlyRate']);
  assert.deepEqual(s1.messages.map((m) => m.block.kind), ['welcome', 'user_choice', 'read_report', 'summary', 'goal_question']);
  assert.equal(s1.scenario, null, 'nothing from the document enters the Scenario');

  await store.send('Ile dostanę za 40 godzin?');
  assert.equal(store.getState().nextQuestion?.kind, 'clarify_hours_composition');
  const chip = suggestionsFor(store.getState().nextQuestion, true, 'pl')[0] as string;
  assert.equal(chip, '40 godzin od poniedziałku do piątku');
  await store.send(chip);
  assert.equal(h.remainingTurns(), 0);
  assert.ok(!asked(store).includes('pay.hourlyRate'), 'the document-known rate is not asked again');
  assertCleanRequests(h.turnBodies);

  const s = store.getState();
  const rateRow = panelRows(s).find((r) => r.field === 'pay.hourlyRate');
  assert.equal(rateRow?.node, null, 'the rate stays out of the Scenario');
  assert.equal(rateRow?.document?.status, 'document_reading');
  assert.deepEqual(resultReasons(s).map((r) => r.key), ['documentProvisional', 'outOfGoal', 'gate']);
  const end = describeTurn(lastTurn(store), PL, 'pl');
  assert.equal(end.question, null);
  assert.ok(end.closing.includes(PL.turn.noResult));
  assert.match(end.closing.join(' '), /stawka godzinowa brutto \(odczyt z dokumentu — wymaga weryfikacji\)/);
});

test('R3-B case 1 without a model: the free-text goal falls back to the hours question - still no rate question', async () => {
  const h = harness({ reads: { 'p.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case1_goal_no_model });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('p.pdf')], 'payslip');
  await store.read();
  await store.send('Ile dostanę za 40 godzin?');
  const first = describeTurn(lastTurn(store), PL, 'pl');
  assert.ok(first.lines.includes(PL.turn.hints.agent_unavailable as string), 'says honestly it could not interpret it');
  assert.match(first.question ?? '', /Ile godzin chcesz policzyć/);
  await store.send('40 godzin od poniedziałku do piątku');
  assert.equal(h.remainingTurns(), 0);
  assert.ok(!asked(store).includes('pay.hourlyRate'));
});

test('R3-B case 2: no documents - a real R2 step, no reader state; the rate is asked; "nie wiem" is not asked again (PL and EN)', async () => {
  for (const [lang, flow, messages] of [['pl', 'case2_no_documents', ['40 godzin w tygodniu', '40 godzin od poniedziałku do piątku', 'Nie wiem']], ['en', 'case2_no_documents_en', ['40 hours a week', '40 hours Monday to Friday', "I don't know"]]] as const) {
    const h = harness({ turns: fixtures.turns[flow] });
    const store = createR3BStore(h.deps, lang);
    store.continueWithoutDocuments();
    assert.equal(store.getState().phase, 'goal');
    assert.deepEqual(suggestionsFor(null, false, lang).slice(0, 1), [messages[0]]);
    for (const m of messages) await store.send(m);
    assert.equal(h.remainingTurns(), 0, lang);
    assert.equal(h.readCalls.length + h.resolveBodies.length, 0, 'no reader, no profile without documents');
    assert.equal(store.getState().knowledge, null);
    assert.deepEqual(asked(store), ['work.hours', 'pay.hourlyRate', null]);
    const rateQuestion = turnsOf(store.getState())[1]?.block as Extract<ThreadMessage['block'], { kind: 'turn' }>;
    assert.match(describeTurn(rateQuestion, R3B_COPY[lang], lang).question ?? '', lang === 'pl' ? /^Ile wynosi Twoja stawka brutto za godzinę\?$/ : /^What is your gross hourly rate\?$/, 'no "documents" wording without documents');
    const end = describeTurn(lastTurn(store), R3B_COPY[lang], lang);
    assert.ok(end.lines.some((l) => l.includes(lang === 'pl' ? 'nie wpisuję zera' : 'not zero')));
    assert.ok(end.lines.includes(R3B_COPY[lang].turn.deferred(lang === 'pl' ? 'stawka godzinowa brutto' : 'gross hourly rate')), 'put aside, not re-asked');
    assert.deepEqual(store.getState().userDeferred, ['pay.hourlyRate']);
    assertCleanRequests(h.turnBodies);
  }
});

test('R3-B case 3: contract + payslip with different same-period rates - kept as a conflict; ONE grounded question; the choice is a separate user decision', async () => {
  const h = harness({ reads: { 'umowa.pdf': readOk('contract_base_1720'), 'pasek.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case3_conflict_payslip_chosen });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('umowa.pdf')], 'contract_base');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  assert.deepEqual(h.readCalls.map((c) => c.kind), ['contract', 'payslip']);
  const rate = store.getState().knowledge?.facts.find((f) => f.path === 'employment.hourlyRate');
  assert.equal(rate?.status, 'conflict');
  assert.equal(rate?.value, null, 'no value picked');
  assert.deepEqual(rate?.candidates.map((c) => [c.value, c.sources[0]?.role]), [[17.2, 'contract_base'], [16.8, 'payslip']]);
  assert.deepEqual(store.getState().knowledge?.deferrableFields, [], 'a conflict defers nothing');

  await store.send('40 godzin w tygodniu');
  assert.equal(store.getState().phase, 'conflict');
  assert.equal(h.turnBodies.length, 0, 'the conflict is asked before anything is calculated');
  const payslipCandidate = rate?.candidates.find((c) => c.sources[0]?.role === 'payslip')?.candidateId as string;
  await store.chooseConflict(payslipCandidate);
  assert.deepEqual(h.resolveBodies[1], fixtures.profiles.contract_payslip_conflict_payslip_chosen?.request, 'one existing confirm_candidate decision');
  const chosen = store.getState().knowledge?.facts.find((f) => f.path === 'employment.hourlyRate');
  assert.equal(chosen?.status, 'user_confirmed', 'shown as the user\'s choice - not as a document reading');
  assert.equal(chosen?.decidedAt, '2026-10-18T10:00:00.000Z');
  await store.send('40 godzin od poniedziałku do piątku');
  assert.equal(h.remainingTurns(), 0);
  assert.ok(!asked(store).includes('pay.hourlyRate'));
  assertCleanRequests(h.turnBodies);
});

test('R3-B case 3: "nie wiem" to the conflict keeps both values, defers the rate and continues - no amount', async () => {
  const h = harness({ reads: { 'umowa.pdf': readOk('contract_base_1720'), 'pasek.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case3_conflict_left_open });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('umowa.pdf')], 'contract_base');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  await store.send('40 godzin w tygodniu');
  await store.send('nie wiem');
  assert.ok(store.getState().messages.some((m) => m.block.kind === 'conflict_result' && m.block.outcome === 'left_open'));
  await store.send('40 godzin od poniedziałku do piątku');
  assert.equal(h.remainingTurns(), 0);
  const s = store.getState();
  assert.equal(s.knowledge?.facts.find((f) => f.path === 'employment.hourlyRate')?.status, 'conflict', 'still a conflict');
  assert.deepEqual(resultReasons(s).map((r) => r.key), ['conflict', 'missing', 'outOfGoal', 'gate']);
});

test('R3-B case 3: an annex dated 2026-09-01 - the week is asked first; before/after the change there is no conflict', async () => {
  for (const [choice, fixture, value, status] of [['before', 'annex_week_before', 16.8, 'documents_agree'], ['from', 'annex_week_from', 17.2, 'document_reading']] as const) {
    const h = harness({ reads: { 'umowa.pdf': readOk('contract_base_1680'), 'aneks.pdf': readOk('annex_1720_from_2026_09_01'), 'pasek.pdf': readOk('payslip_week33_1680') } });
    const store = createR3BStore(h.deps, 'pl');
    store.addFiles([pdf('umowa.pdf')], 'contract_base');
    store.addFiles([pdf('aneks.pdf')], 'contract_annex');
    store.addFiles([pdf('pasek.pdf')], 'payslip');
    await store.read();
    assert.equal(h.readCalls.length, 0, 'an undated annex is not read');
    assert.ok(store.getState().messages.some((m) => m.block.kind === 'note' && m.block.note === 'annex_date_missing'));
    store.setAnnexDate('doc-2', '2026-09-01');
    await store.read();
    assert.equal(store.getState().phase, 'period');
    assert.equal(h.resolveBodies.length, 0, 'today\'s date is never chosen silently');
    await store.choosePeriod({ kind: choice, date: '2026-09-01' });
    assert.deepEqual(h.resolveBodies, [fixtures.profiles[fixture]?.request]);
    const rate = store.getState().knowledge?.facts.find((f) => f.path === 'employment.hourlyRate');
    assert.equal(rate?.status, status, choice);
    assert.equal(rate?.value, value);
    if (choice === 'from') assert.ok((rate?.otherPeriods.length ?? 0) > 0, 'the August reading is shown as another period, not a conflict');
  }
});

test('R3-B case 4: a partly read document keeps its valid facts; a failed read is never shown as read and the user can continue', async () => {
  const partial = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680_page1_of_2', { totalPages: 2, notProcessedPages: [2], reason: 'batch_failed' }) } });
  const store = createR3BStore(partial.deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  const report = store.getState().messages.find((m) => m.block.kind === 'read_report')?.block as Extract<ThreadMessage['block'], { kind: 'read_report' }>;
  assert.match(readReportLines(report.items, report.anyRead, store.getState().docs, PL).join(' '), /Pasek wypłaty 1: odczytany częściowo — nie odczytano stron 2 z 2 \(błąd odczytu\)/);
  assert.equal(store.getState().knowledge?.facts.find((f) => f.path === 'employment.hourlyRate')?.value, 16.8, 'valid facts retained');

  const failed = harness({ reads: { 'pasek.pdf': { status: 'error', errorCode: 'vision_unavailable' }, 'skan.jpg': 'throw' } });
  const s2 = createR3BStore(failed.deps, 'pl');
  s2.addFiles([pdf('pasek.pdf'), pdf('skan.jpg', 4096, 'image/jpeg')], 'payslip');
  await s2.read();
  assert.deepEqual(s2.getState().docs.map((d) => [d.status, d.errorCode]), [['failed', 'vision_unavailable'], ['failed', 'file_unreadable']]);
  assert.equal(failed.resolveBodies.length, 0, 'no profile, no fabricated summary');
  assert.equal(s2.getState().knowledge, null);
  assert.ok(!s2.getState().messages.some((m) => m.block.kind === 'summary'));
  const lines = readReportLines((s2.getState().messages.at(-1)?.block as Extract<ThreadMessage['block'], { kind: 'read_report' }>).items, false, s2.getState().docs, PL);
  assert.deepEqual(lines, [
    'Pasek wypłaty 1: nie udało się odczytać — na tym adresie czytnik dokumentów (Gemini) nie jest skonfigurowany — to zwykle kopia testowa (Preview); główna wersja Loonto: nl-payslip-app.vercel.app. Niczego z niego nie przyjmuję.',
    'Pasek wypłaty 2: nie udało się odczytać — nie udało się otworzyć pliku. Niczego z niego nie przyjmuję.',
    PL.readReport.noneRead,
  ]);
  assert.equal(s2.getState().phase, 'documents');
  s2.continueWithoutDocuments();
  assert.equal(s2.getState().phase, 'goal', 'the user can continue without documents');

  const mixed = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680'), 'umowa.pdf': { status: 'error', errorCode: 'extraction_failed' } } });
  const s3 = createR3BStore(mixed.deps, 'pl');
  s3.addFiles([pdf('pasek.pdf')], 'payslip');
  s3.addFiles([pdf('umowa.pdf')], 'contract_base');
  await s3.read();
  assert.deepEqual(mixed.resolveBodies, [fixtures.profiles.payslip_only?.request], 'only the read document reaches the profile');
});

test('R3-B case 5: instruction text in a document stays inert; a bare "150%" is never sent - its meaning is asked; a night allowance is not the Saturday premium; repeated "nie wiem" ends', async () => {
  // Instruction text printed in a payslip: the profile reads the rate as usual; nothing of it reaches the conversation.
  const injected = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_instruction_text') }, turns: fixtures.turns.case1_goal_no_model.slice(0, 1) });
  const s0 = createR3BStore(injected.deps, 'pl');
  s0.addFiles([pdf('pasek.pdf')], 'payslip');
  await s0.read();
  assert.equal(s0.getState().knowledge?.facts.find((f) => f.path === 'employment.hourlyRate')?.value, 16.8);
  await s0.send('Ile dostanę za 40 godzin?');
  assertCleanRequests(injected.turnBodies);

  // "150%" on the Saturday question.
  const h = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case5_saturday_total_150 });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  for (const m of ['40 godzin w tygodniu', 'Nie', '32 godziny od poniedziałku do piątku i 8 godzin w sobotę']) await store.send(m);
  assert.equal(store.getState().nextQuestion?.field, 'pay.saturdayPremiumPercent');
  assert.deepEqual(suggestionsFor(store.getState().nextQuestion, true, 'pl'), ['50%', '150%', 'Nie wiem']);
  const sent = h.turnBodies.length;
  await store.send('150%');
  assert.equal(h.turnBodies.length, sent, 'a bare 150% is NOT sent to R2 (P1 open)');
  assert.equal(store.getState().phase, 'percent');
  await store.choosePercent('total');
  assert.equal(h.turnBodies.at(-1)?.message, '50%', '"150% in total" is sent as +50% above base - the user decided');
  assert.equal(h.remainingTurns(), 0);
  assert.deepEqual(store.getState().scenario?.pay.saturdayPremiumPercent, { state: 'known', value: 50, source: 'user' });

  // Night allowance while Saturday is asked, then "nie wiem" twice.
  const n = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case5_night_allowance_and_dont_know });
  const night = createR3BStore(n.deps, 'pl');
  night.addFiles([pdf('pasek.pdf')], 'payslip');
  await night.read();
  await night.send('32 godziny od poniedziałku do piątku i 8 godzin w sobotę');
  await night.send('dodatek nocny 50%');
  const nightTurn = describeTurn(lastTurn(night), PL, 'pl');
  assert.ok(nightTurn.lines.some((l) => l.startsWith('Nie zapisuję tego jako „dodatek za sobotę”')));
  assert.equal(night.getState().scenario?.pay.saturdayPremiumPercent, undefined);
  await night.send('Nie wiem');
  assert.equal(night.getState().nextQuestion?.kind, 'offer_assumption', 'an explicit assumption is OFFERED, never applied');
  assert.match(describeTurn(lastTurn(night), PL, 'pl').question ?? '', /założenie Loonto: dodatek za sobotę \+50% ponad stawkę/);
  await night.send('Nie wiem');
  assert.equal(n.remainingTurns(), 0);
  assert.equal(night.getState().nextQuestion, null);
  assert.equal((night.getState().scenario?.pay.saturdayPremiumPercent as { state?: string } | undefined)?.state, 'unknown', 'not accepted, not zero');

  // G23: repeated "nie wiem" without documents.
  const g = harness({ turns: fixtures.turns.g23_repeated_dont_know });
  const g23 = createR3BStore(g.deps, 'pl');
  g23.continueWithoutDocuments();
  await g23.send('Nie wiem');
  await g23.send('Nie wiem');
  assert.equal(g.remainingTurns(), 0);
  assert.deepEqual(asked(g23), ['pay.hourlyRate', null]);
  for (const body of [...h.turnBodies, ...n.turnBodies, ...g.turnBodies]) assert.ok(!JSON.stringify(body).includes('"source":"document"'));
});

test('R3-B: an edit is a separate user value with its date - the document reading is unchanged', async () => {
  const h = harness({ reads: { 'p.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case1_goal_no_model });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('p.pdf')], 'payslip');
  await store.read();
  await store.send('Ile dostanę za 40 godzin?');
  await store.send('40 godzin od poniedziałku do piątku');
  assert.deepEqual(store.edit('pay.hourlyRate', 'abc'), { ok: false, error: 'not_a_number' });
  assert.deepEqual(store.edit('pay.hourlyRate', '0'), { ok: false, error: 'out_of_range' });
  assert.deepEqual(store.edit('pay.hourlyRate', '17,20'), { ok: true });
  const s = store.getState();
  assert.deepEqual(s.scenario?.pay.hourlyRate, { state: 'known', value: 17.2, source: 'user' });
  assert.deepEqual(s.corrections, [{ field: 'pay.hourlyRate', value: 17.2, enteredAt: '2026-10-18T10:00:00.000Z', documentValue: 16.8 }]);
  const fact = s.knowledge?.facts.find((f) => f.path === 'employment.hourlyRate');
  assert.equal(fact?.value, 16.8);
  assert.equal(fact?.status, 'document_reading', 'the document reading is not rewritten');
  const row = panelRows(s).find((r) => r.field === 'pay.hourlyRate');
  assert.equal(row?.node?.value, 17.2);
  assert.equal(row?.document?.value, 16.8, 'both shown side by side');
});

test('R3-B: removal and reset drop the files; a removed read document leaves the profile without a new reader call', async () => {
  const h = harness({ reads: { 'p.pdf': readOk('payslip_week33_1680') } });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('p.pdf')], 'payslip');
  await store.read();
  await store.removeDocument('doc-1');
  assert.deepEqual(store.getState().docs, []);
  assert.equal(store.getState().knowledge, null);
  assert.equal(h.readCalls.length, 1);
  store.addFiles([pdf('q.pdf')], 'payslip');
  store.reset();
  assert.deepEqual(store.getState().docs, []);
  assert.deepEqual(store.getState().messages.map((m) => m.block.kind), ['welcome']);
  assert.equal(store.getState().scenario, null);
});

test('R3-B: only PDF / JPG / PNG up to 20 MB; typing a goal with unread documents asks to read or remove them first', async () => {
  const h = harness();
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([new File(['x'], 'umowa.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), pdf('big.pdf', 20 * 1024 * 1024 + 1), new File([], 'empty.pdf', { type: 'application/pdf' }), pdf('ok.pdf')], 'contract_base');
  assert.deepEqual(store.getState().fileErrors.map((e) => [e.name, e.reason]), [['umowa.docx', 'type'], ['big.pdf', 'size'], ['empty.pdf', 'empty']]);
  assert.deepEqual(store.getState().docs.map((d) => d.fileName), ['ok.pdf']);
  await store.send('Ile dostanę za 40 godzin?');
  assert.equal(store.getState().messages.at(-1)?.block.kind, 'note');
  assert.equal(h.readCalls.length + h.turnBodies.length, 0);
});

test('R3-B: a failed turn changes nothing and says so', async () => {
  const h = harness({ turnFailure: 1 });
  const store = createR3BStore(h.deps, 'pl');
  store.continueWithoutDocuments();
  await store.send('40 godzin w tygodniu');
  const s = store.getState();
  assert.equal(s.messages.at(-1)?.block.kind, 'turn_failed');
  assert.equal(s.scenario, null);
  assert.equal(s.phase, 'goal');
});

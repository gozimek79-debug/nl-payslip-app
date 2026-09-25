import { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, Calculator as CalculatorIcon, Clock, FileText, ShieldCheck } from 'lucide-react';
import { TierACalculator } from './TierACalculator.tsx';
import { TierBFlow } from './TierBFlow.tsx';
import { ProDocuments } from './ProDocuments.tsx';
import { AccountPage } from './AccountPage.tsx';
import { ContractAnalysis } from './ContractAnalysis.tsx';
import { translations, type Lang } from './translations.ts';

/**
 * Navigation restructure (SPEC-loonto-architecture.md §8a, architecture round): four top-level
 * items - Kalkulator/Analiza/Słownik/Konto - with tiers living INSIDE Kalkulator, not in the top
 * bar. 'kalkulator' with kalkulatorTier===null is the tier-selection landing page (spec's own
 * explicit "no wizard, self-select from cards" decision, §8a).
 *
 * 'z_umowy' (Tier B, audit "CONSOLIDATED ASSIGNMENT" round §3) routes to TierBFlow - contract
 * upload pre-fills the same TierACalculator component Tier A uses, marked contract_extracted and
 * fully correctable, per §3.1's "nothing more than pre-fill Tier A" scope.
 *
 * 'pro' (Tier C) routed to TierCFlow directly (single-payslip upload) through stage 2. Stage 3.0
 * ("PRO accepts several documents") replaces that direct mount with ProDocuments - the multi-
 * document shell that holds a contract, its annexes and payslips together, per §3.0.2's own
 * "replace the single-file upload with an add/list/remove flow." TierCFlow.tsx itself is untouched
 * and unimported here - ProDocuments calls its same `/api/tier-c/analyze` endpoint directly for a
 * payslip entry, showing a compact status line rather than TierCFlow's own full discrepancy panel
 * (deliberately out of this round's scope - see ProDocuments.tsx's own doc comment). Only PRO's
 * direct entry point changes; TierCFlow's component and route are untouched.
 */
type Mode = 'kalkulator' | 'analiza' | 'slownik' | 'account';
type KalkulatorTier = 'szybki' | 'z_umowy' | 'pro' | null;
type AnalizaModule = 'umowa' | 'paski' | null;
type User = { id: string; email: string };
type HistoryItem = { id: string; fileName: string; status: string; createdAt: string };

function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem('loonto-lang');
    if (stored === 'pl' || stored === 'en') return stored;
  } catch { /* ignore */ }
  return 'pl';
}

export function App() {
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const t = translations[lang];
  const [mode, setMode] = useState<Mode>('kalkulator');
  const [kalkulatorTier, setKalkulatorTier] = useState<KalkulatorTier>(null);
  const [analizaModule, setAnalizaModule] = useState<AnalizaModule>(null);
  const [message, setMessage] = useState('');
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authNotice, setAuthNotice] = useState<'success' | 'expired' | 'invalid' | 'error' | null>(null);

  useEffect(() => {
    void fetch('/api/auth/me').then((response) => response.json()).then((data: { user: User | null }) => setUser(data.user)).catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (auth === 'success' || auth === 'expired' || auth === 'invalid' || auth === 'error') {
      setAuthNotice(auth);
      if (auth === 'success') { setMode('account'); void loadHistory(); }
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    try { localStorage.setItem('loonto-lang', lang); } catch { /* ignore */ }
  }, [lang]);

  async function login() {
    setMagicLinkSent(false);
    const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, language: lang }) });
    const data = await response.json() as { sent?: boolean; error?: string };
    if (!response.ok || !data.sent) { setMessage(data.error ?? 'Error'); return; }
    setMessage(''); setMagicLinkSent(true);
  }

  async function loadHistory() {
    const response = await fetch('/api/auth/history');
    if (response.ok) { const data = await response.json() as { items: HistoryItem[] }; setHistory(data.items); }
  }

  async function logout() {
    await fetch('/api/auth/session', { method: 'DELETE' });
    setUser(null); setHistory([]); setAccountOpen(false); setMode('kalkulator'); setKalkulatorTier(null);
  }

  async function deleteMyData() {
    await fetch('/api/auth/me/data', { method: 'DELETE' });
    setHistory([]);
  }

  return <div className="app-shell">
    <header className="site-header">
      <button className="brand plain-button" onClick={() => { setMode('kalkulator'); setKalkulatorTier(null); }}><span className="brand-mark">L</span>loonto</button>
      <nav>
        <div className="lang-switch">
          <button type="button" className={lang === 'pl' ? 'active' : ''} onClick={() => setLang('pl')}>PL</button>
          <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
        <button type="button" className={`mode-switch ${mode === 'kalkulator' ? 'active' : ''}`} onClick={() => setMode('kalkulator')}><CalculatorIcon size={15}/> {t.nav.kalkulator}</button>
        <button type="button" className={`mode-switch ${mode === 'analiza' ? 'active' : ''}`} onClick={() => setMode('analiza')}><ShieldCheck size={15}/> {t.nav.analiza}</button>
        <button type="button" className={`mode-switch ${mode === 'slownik' ? 'active' : ''}`} onClick={() => setMode('slownik')}><BookOpen size={15}/> {t.nav.slownik}</button>
        <button type="button" className={`mode-switch ${mode === 'account' ? 'active' : ''}`} onClick={() => { if (user) { setMode('account'); void loadHistory(); } else { setAccountOpen(true); } }}>{user ? t.nav.account : t.nav.login}</button>
      </nav>
    </header>
    {authNotice && !accountOpen && <div className={`status ${authNotice === 'success' ? '' : 'error'} auth-notice`} role="status">{authNotice === 'success' ? t.account.noticeSuccess : authNotice === 'expired' ? t.account.noticeExpired : authNotice === 'invalid' ? t.account.noticeInvalid : t.account.noticeError}</div>}
    {accountOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setAccountOpen(false)}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => { setAccountOpen(false); setMagicLinkSent(false); setAuthNotice(null); }} aria-label={t.account.close}>×</button>{magicLinkSent ? <><span className="step">{t.account.title}</span><h2 id="account-title">{t.account.sentTitle}</h2><p>{t.account.sentBody(email)}</p><button className="secondary" onClick={() => void login()}>{t.account.resend}</button></> : <form onSubmit={event => { event.preventDefault(); void login(); }}><span className="step">{t.account.title}</span><h2 id="account-title">{t.account.heading}</h2><p>{t.account.intro}</p><label className="email-label">{t.account.email}<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com"/></label>{message && <div className="status error">{message}</div>}<button className="primary" type="submit">{t.account.continue}</button></form>}</section></div>}
    <main id="top">
      {mode === 'kalkulator' && kalkulatorTier === null && (
        <section className="flow-page">
          <div className="flow-heading"><h1>{t.kalkulatorHome.title}</h1><p>{t.kalkulatorHome.lead}</p></div>
          <div className="tier-cards">
            <button type="button" className="tier-card" onClick={() => setKalkulatorTier('szybki')}>
              <CalculatorIcon size={22}/><h3>{t.kalkulatorHome.szybkiName}</h3><p className="tier-need">{t.kalkulatorHome.szybkiNeed}</p><small className="form-note">{t.kalkulatorHome.szybkiLimit}</small>
            </button>
            {/* 2.0a (audit "CONSOLIDATED ASSIGNMENT" v8): Tier B withdrawn by owner decision - its
                one distinctive contribution (a contract stating the overtime threshold) did not
                hold on the one real document available. Card hidden, nothing deleted - TierBFlow.tsx
                and the 'z_umowy' route below still exist; the contract upload/extraction/pre-fill
                logic is what "returns as part of PRO" per spec §4, not rebuilt from scratch. */}
            <button type="button" className="tier-card" onClick={() => setKalkulatorTier('pro')}>
              <ShieldCheck size={22}/><h3>{t.kalkulatorHome.proName}</h3><p className="tier-need">{t.kalkulatorHome.proNeed}</p><small className="form-note">{t.kalkulatorHome.proLimit}</small>
            </button>
          </div>
        </section>
      )}
      {mode === 'kalkulator' && kalkulatorTier === 'szybki' && (
        <>
          <button className="back plain-button tier-back" onClick={() => setKalkulatorTier(null)}><ArrowLeft size={17}/>{t.kalkulatorHome.back}</button>
          <TierACalculator lang={lang} onNavigateToDictionary={() => setMode('slownik')}/>
        </>
      )}
      {mode === 'kalkulator' && kalkulatorTier === 'z_umowy' && (
        <>
          <button className="back plain-button tier-back" onClick={() => setKalkulatorTier(null)}><ArrowLeft size={17}/>{t.kalkulatorHome.back}</button>
          <TierBFlow lang={lang} onNavigateToDictionary={() => setMode('slownik')}/>
        </>
      )}
      {mode === 'kalkulator' && kalkulatorTier === 'pro' && (
        <>
          <button className="back plain-button tier-back" onClick={() => setKalkulatorTier(null)}><ArrowLeft size={17}/>{t.kalkulatorHome.back}</button>
          <ProDocuments lang={lang} onNavigateToDictionary={() => setMode('slownik')}/>
        </>
      )}
      {mode === 'analiza' && analizaModule === null && (
        <section className="flow-page">
          <div className="flow-heading"><h1>{t.analizaHome.title}</h1><p>{t.analizaHome.lead}</p></div>
          <div className="tier-cards">
            <button type="button" className="tier-card" onClick={() => setAnalizaModule('umowa')}>
              <FileText size={22}/><h3>{t.analizaHome.umowaName}</h3><p className="tier-need">{t.analizaHome.umowaNeed}</p>
            </button>
            <button type="button" className="tier-card tier-card-disabled" onClick={() => setAnalizaModule('paski')}>
              <ShieldCheck size={22}/><h3>{t.analizaHome.paskiName}</h3><p className="tier-need">{t.analizaHome.paskiNeed}</p>
              <span className="tier-badge"><Clock size={12}/> {t.kalkulatorHome.comingSoon}</span>
            </button>
          </div>
        </section>
      )}
      {mode === 'analiza' && analizaModule === 'umowa' && (
        <>
          <button className="back plain-button tier-back" onClick={() => setAnalizaModule(null)}><ArrowLeft size={17}/>{t.analizaHome.back}</button>
          <ContractAnalysis lang={lang}/>
        </>
      )}
      {mode === 'analiza' && analizaModule === 'paski' && (
        <section className="flow-page">
          <button className="back plain-button tier-back" onClick={() => setAnalizaModule(null)}><ArrowLeft size={17}/>{t.analizaHome.back}</button>
          <div className="notice-card"><Clock/><div><h3>{t.comingSoon.title}</h3><p>{t.comingSoon.body}</p></div></div>
        </section>
      )}
      {mode === 'slownik' && (
        <section className="flow-page">
          <div className="flow-heading"><h1>{t.slownikHome.title}</h1><p>{t.slownikHome.lead}</p></div>
          <div className="notice-card"><Clock/><div><h3>{t.comingSoon.title}</h3><p>{t.comingSoon.body}</p></div></div>
        </section>
      )}
      {mode === 'account' && user && <AccountPage lang={lang} user={user} history={history} onBack={() => { setMode('kalkulator'); setKalkulatorTier(null); }} onLogout={() => void logout()} onStartAnalysis={() => { setMode('kalkulator'); setKalkulatorTier('pro'); }} onDeleteData={deleteMyData}/>}
    </main>
  </div>;
}

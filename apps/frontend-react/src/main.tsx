import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { appEntry } from './r3b/r3b-entry.ts';
import './styles.css';
// AI-001 owner-only Private Alpha: the module shell is the default at `/` (PRO = AI advisor) and takes the `/?auth=`
// sign-in return; the previous app stays at `/?legacy=1`, R3-B at `/?r3b=1`, the R3-A scripted demo at `/?r3a=demo`.
// R3-B and R3-A are loaded on demand.
const R3BDocumentConversation = lazy(() => import('./r3b/R3BDocumentConversation.tsx').then((m) => ({ default: m.R3BDocumentConversation })));
const R3AConversationDemo = lazy(() => import('./r3a/R3AConversationDemo.tsx').then((m) => ({ default: m.R3AConversationDemo })));
const entry = appEntry(window.location.search);
createRoot(document.getElementById('root')!).render(<StrictMode>{entry === 'shell' ? <App /> : entry === 'legacy' ? <App proMode="documents" /> : entry === 'r3a_demo' ? <Suspense fallback={null}><R3AConversationDemo /></Suspense> : <Suspense fallback={null}><R3BDocumentConversation /></Suspense>}</StrictMode>);

import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { appEntry } from './r3b/r3b-entry.ts';
import './styles.css';
// R3-B.1 owner-only Private Alpha: R3-B is the default at `/`; the previous app stays at `/?legacy=1` (and its
// `/?auth=` sign-in return); `/?r3a=demo` the earlier R3-A scripted demo. Loaded on demand.
const R3BDocumentConversation = lazy(() => import('./r3b/R3BDocumentConversation.tsx').then((m) => ({ default: m.R3BDocumentConversation })));
const R3AConversationDemo = lazy(() => import('./r3a/R3AConversationDemo.tsx').then((m) => ({ default: m.R3AConversationDemo })));
const entry = appEntry(window.location.search);
createRoot(document.getElementById('root')!).render(<StrictMode>{entry === 'legacy' ? <App /> : entry === 'r3a_demo' ? <Suspense fallback={null}><R3AConversationDemo /></Suspense> : <Suspense fallback={null}><R3BDocumentConversation /></Suspense>}</StrictMode>);

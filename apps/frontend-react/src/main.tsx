import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { alphaEntry } from './r3b/r3b-entry.ts';
import './styles.css';
// Private Alpha owner-review entries (feature branch), loaded on demand so the existing app is unchanged:
// `/?r3a=1` R3-B document-first conversation; `/?r3a=demo` the earlier R3-A scripted demo.
const R3BDocumentConversation = lazy(() => import('./r3b/R3BDocumentConversation.tsx').then((m) => ({ default: m.R3BDocumentConversation })));
const R3AConversationDemo = lazy(() => import('./r3a/R3AConversationDemo.tsx').then((m) => ({ default: m.R3AConversationDemo })));
const entry = alphaEntry(window.location.search);
createRoot(document.getElementById('root')!).render(<StrictMode>{entry === 'r3b' ? <Suspense fallback={null}><R3BDocumentConversation /></Suspense> : entry === 'r3a_demo' ? <Suspense fallback={null}><R3AConversationDemo /></Suspense> : <App />}</StrictMode>);

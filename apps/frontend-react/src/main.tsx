import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { isR3aDemoRequested } from './r3a/r3a-entry.ts';
import './styles.css';
// R3-A conversational UI demo (synthetic data, feature branch): only `/?r3a=1`, loaded on demand so the existing app is unchanged.
const R3AConversationDemo = lazy(() => import('./r3a/R3AConversationDemo.tsx').then((m) => ({ default: m.R3AConversationDemo })));
createRoot(document.getElementById('root')!).render(<StrictMode>{isR3aDemoRequested(window.location.search) ? <Suspense fallback={null}><R3AConversationDemo /></Suspense> : <App />}</StrictMode>);

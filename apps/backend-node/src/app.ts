import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import payslipRouter from './controllers/payslip.controller.js';
import authRouter from './controllers/auth.controller.js';
import calculatorRouter from './controllers/calculator.controller.js';
import contractRouter from './controllers/contract.controller.js';
import aiRouter from './controllers/ai.controller.js';
import maintenanceRouter from './controllers/maintenance.controller.js';
import tierARouter from './controllers/tier-a.controller.js';
import tierCRouter from './controllers/tier-c.controller.js';
import { checkDatabase } from './database.js';
import { activeDocumentVisionConfig } from './ai-service/document-vision-provider.js';

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', async (_req, res) => {
  const database = await checkDatabase();
  // v18 (audit): "which build served this request" had no answer after the fact this round - the
  // owner's retest results couldn't be tied to a specific deployment, and by the time that was
  // asked, Vercel's own log retention had already rolled past the request anyway. Both vars are set
  // automatically by Vercel on every deployment (confirmed present via `vercel env pull`, no new
  // config needed); null outside Vercel (local dev), which is itself useful information, not an
  // error to hide.
  // Stage 2e (§2e.7): "report the configured reading provider's name on /api/health (a name, never a
  // key), so production can be checked instead of assumed" - the provider name only (e.g. "Mistral La
  // Plateforme..."), never the API key or its env var name.
  res.json({
    status: database === 'unavailable' ? 'degraded' : 'ok',
    database,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    deploymentUrl: process.env.VERCEL_URL ?? null,
    documentVisionProvider: activeDocumentVisionConfig().label,
  });
});

app.use('/api/payslips', payslipRouter);
app.use('/api/auth', authRouter);
app.use('/api/calculator', calculatorRouter);
app.use('/api/contracts', contractRouter);
app.use('/api/ai', aiRouter);
app.use('/api/maintenance', maintenanceRouter);
app.use('/api/tier-a', tierARouter);
app.use('/api/tier-c', tierCRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Nie znaleziono zasobu' });
});

export default app;

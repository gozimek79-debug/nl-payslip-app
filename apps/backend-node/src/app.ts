import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import payslipRouter from './controllers/payslip.controller.js';
import authRouter from './controllers/auth.controller.js';
import calculatorRouter from './controllers/calculator.controller.js';
import contractRouter from './controllers/contract.controller.js';
import aiRouter from './controllers/ai.controller.js';
import { checkDatabase } from './database.js';

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '12mb' }));

app.get('/api/health', async (_req, res) => {
  const database = await checkDatabase();
  res.json({ status: database === 'unavailable' ? 'degraded' : 'ok', database });
});

app.use('/api/payslips', payslipRouter);
app.use('/api/auth', authRouter);
app.use('/api/calculator', calculatorRouter);
app.use('/api/contracts', contractRouter);
app.use('/api/ai', aiRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Nie znaleziono zasobu' });
});

export default app;

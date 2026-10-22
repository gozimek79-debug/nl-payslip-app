import express from 'express';
import { isGroqConfigured } from '../ai-service/groq.js';
import { readingProviderStatus } from '../ai-service/gemini-client.js';

const router = express.Router();

/**
 * Stage 2h (audit v28, §2h.6): "GET /api/ai/status reports readingProviderStatus() instead of
 * reading GROQ_API_KEY; nothing else changes." `visionAvailable` was still checking `GROQ_API_KEY`
 * (via `isVisionConfigured`) even though document reading moved to Mistral in stage 2c - flagged by
 * both the contractor (stage 2h report) and the reviewer as stale. `available` stays `isGroqConfigured()`
 * unchanged: Groq is still genuinely used for `/explain`'s text-explanation call, a different feature
 * this field was always about.
 */
router.get('/status', (_req, res) => {
  // AI-001: `advisorAvailable` - whether THIS host can run the AI Advisor (a configured model); the interface says so
  // up front instead of letting a user type into an advisor that cannot answer.
  res.json({ available: isGroqConfigured(), visionAvailable: readingProviderStatus().status === 'ready', advisorAvailable: isGroqConfigured() });
});

export default router;

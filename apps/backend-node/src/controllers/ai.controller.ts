import express from 'express';
import { isGroqConfigured, isVisionConfigured } from '../ai-service/groq.js';

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({ available: isGroqConfigured(), visionAvailable: isVisionConfigured() });
});

export default router;

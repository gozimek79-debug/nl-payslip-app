import express from 'express';
import { query } from '../database.js';

const router = express.Router();

/**
 * Enforces the retention_until column that has existed on `payslips` since it was first written
 * (set to now() + 24h at upload time) but was never actually acted on — audit finding E4.
 * analyses and payslip_fields need no retention logic of their own: both have
 * `payslip_id ... ON DELETE CASCADE`, so deleting the expired payslip row already removes them.
 * This also resolves the "anonymous upload nobody can ever delete" half of E3: retention_until is
 * set uniformly regardless of whether the row has a user_id, so anonymous rows expire on the same
 * schedule as everyone else's instead of being permanently unreachable.
 *
 * Intended to be invoked by Vercel Cron (see the `crons` entry in vercel.json) rather than a
 * user-facing route, hence the shared-secret check instead of session auth.
 */
// Vercel Cron always sends GET, not POST — see vercel.json's `crons` entry.
router.get('/cleanup-expired', async (req, res) => {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  try {
    const deleted = await query<{ id: string }>(
      `DELETE FROM payslips WHERE retention_until < now() RETURNING id`,
    );
    return res.json({ deletedCount: deleted.length });
  } catch (error) {
    console.error('Retention cleanup failed', error);
    return res.status(500).json({ error: 'Cleanup failed.' });
  }
});

export default router;

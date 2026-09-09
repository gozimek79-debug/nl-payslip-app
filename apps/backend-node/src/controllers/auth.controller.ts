import { randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { createSession, currentUser, destroySession, hashToken, requireUser, type AuthUser } from '../auth.js';
import { databaseConfigured, query } from '../database.js';
import { isResendConfigured, sendMagicLinkEmail } from '../email-service/resend-client.js';

const router = express.Router();
const emailSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  language: z.enum(['pl', 'en']).optional(),
});

const MAGIC_LINK_MINUTES = 15;
const RESEND_COOLDOWN_SECONDS = 60;

router.post('/session', async (req, res) => {
  if (!databaseConfigured) return res.status(503).json({ error: 'Baza danych nie jest skonfigurowana.' });
  if (!isResendConfigured()) return res.status(503).json({ error: 'Wysyłka e-maili logowania nie jest skonfigurowana.' });

  const parsed = emailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Podaj poprawny adres e-mail.' });
  const { email } = parsed.data;
  const language = parsed.data.language ?? 'pl';

  try {
    const recent = await query<{ id: string }>(
      `SELECT id FROM magic_links
       WHERE email = $1 AND used_at IS NULL AND created_at > now() - ($2 * interval '1 second')
       LIMIT 1`,
      [email, RESEND_COOLDOWN_SECONDS],
    );
    if (recent.length > 0) {
      return res.status(202).json({ sent: true });
    }

    const token = randomBytes(32).toString('base64url');
    await query(
      `INSERT INTO magic_links (email, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 minute'))`,
      [email, hashToken(token), MAGIC_LINK_MINUTES],
    );

    const origin = `${req.protocol}://${req.get('host')}`;
    const magicLinkUrl = `${origin}/api/auth/verify?token=${token}`;
    await sendMagicLinkEmail(email, magicLinkUrl, language);

    return res.status(202).json({ sent: true });
  } catch (error) {
    console.error('Could not send magic link', error);
    return res.status(502).json({ error: 'Nie udało się wysłać e-maila logowania. Spróbuj ponownie.' });
  }
});

router.get('/verify', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.redirect('/?auth=invalid');

  try {
    const links = await query<{ id: string; email: string }>(
      `SELECT id, email FROM magic_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token)],
    );
    const link = links[0];
    if (!link) return res.redirect('/?auth=expired');

    await query(`UPDATE magic_links SET used_at = now() WHERE id = $1`, [link.id]);

    const users = await query<AuthUser>(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET status = 'active'
       RETURNING id, email`,
      [link.email],
    );
    const user = users[0];
    if (!user) return res.redirect('/?auth=error');

    await createSession(user.id, res);
    return res.redirect('/?auth=success');
  } catch (error) {
    console.error('Magic link verification failed', error);
    return res.redirect('/?auth=error');
  }
});

router.get('/me', async (req, res) => {
  const user = await currentUser(req);
  return res.json({ user });
});

router.delete('/session', async (req, res) => {
  await destroySession(req, res);
  return res.status(204).end();
});

router.get('/history', requireUser, async (_req, res) => {
  const user = res.locals.user as AuthUser;
  const items = await query(
    `SELECT p.id, p.original_name AS "fileName", p.status, p.created_at AS "createdAt",
            a.result
     FROM payslips p
     LEFT JOIN LATERAL (
       SELECT result FROM analyses WHERE payslip_id = p.id ORDER BY created_at DESC LIMIT 1
     ) a ON true
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC LIMIT 50`,
    [user.id],
  );
  return res.json({ items });
});

// Audit finding E4: only reaches rows with a user_id, since deletion has to be requested by
// someone the row is attributably owned by. Anonymous uploads have no owner who could call this;
// they are instead covered by the scheduled retention_until cleanup (maintenance.controller.ts).
router.delete('/me/data', requireUser, async (_req, res) => {
  const user = res.locals.user as AuthUser;
  const deleted = await query<{ id: string }>(`DELETE FROM payslips WHERE user_id = $1 RETURNING id`, [user.id]);
  return res.json({ deletedCount: deleted.length });
});

export default router;

export type EmailLocale = 'pl' | 'en';

export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS || 'Loonto <onboarding@resend.dev>';

function magicLinkHtml(magicLinkUrl: string, locale: EmailLocale): string {
  const heading = locale === 'en' ? 'Sign in to Loonto' : 'Zaloguj się do Loonto';
  const body = locale === 'en'
    ? 'Click the button below to sign in. This link expires in 15 minutes and can be used once.'
    : 'Kliknij przycisk poniżej, aby się zalogować. Link jest ważny 15 minut i można go użyć tylko raz.';
  const button = locale === 'en' ? 'Sign in' : 'Zaloguj się';
  const ignore = locale === 'en'
    ? "If you didn't request this, you can safely ignore this email."
    : 'Jeśli to nie Ty prosiłeś o logowanie, możesz zignorować tę wiadomość.';
  return `
<div style="font-family:'DM Sans',Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#16251f">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:24px">
    <div style="width:32px;height:32px;border-radius:10px;background:#147d58;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:18px">L</div>
    <strong style="font-size:20px">loonto</strong>
  </div>
  <h1 style="font-size:22px;margin:0 0 12px">${heading}</h1>
  <p style="font-size:15px;line-height:1.6;color:#3d4d45;margin:0 0 24px">${body}</p>
  <a href="${magicLinkUrl}" style="display:inline-block;background:#147d58;color:#fff;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:12px">${button}</a>
  <p style="font-size:13px;color:#6a776f;margin-top:28px">${ignore}</p>
</div>
`.trim();
}

export async function sendMagicLinkEmail(email: string, magicLinkUrl: string, locale: EmailLocale): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY nie jest skonfigurowany.');

  const subject = locale === 'en' ? 'Your Loonto sign-in link' : 'Twój link logowania do Loonto';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [email],
      subject,
      html: magicLinkHtml(magicLinkUrl, locale),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend API error ${response.status}: ${detail}`);
  }
}

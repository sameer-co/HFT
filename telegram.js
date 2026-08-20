export async function sendTelegramMessage({ botToken, chatId, text }) {
  if (!botToken || !chatId) {
    // No Telegram configured yet - just log locally so nothing is lost.
    console.log('[telegram not configured]\n' + text + '\n');
    return;
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error('Telegram send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

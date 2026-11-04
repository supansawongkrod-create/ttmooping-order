const crypto = require('crypto');

const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ORDER_SESSION_SECRET = process.env.ORDER_SESSION_SECRET;
const ORDER_URL = 'https://ttmooping-order.vercel.app/';
const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false });
  }

  try {
    if (
      !LINE_CHANNEL_ID ||
      !LINE_CHANNEL_SECRET ||
      !ORDER_SESSION_SECRET
    ) {
      throw new Error('Required environment variables missing');
    }

    const signature = String(req.headers['x-line-signature'] || '');
    const rawBody =
      typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body || {});
    const expectedSignature = crypto
      .createHmac('sha256', LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest('base64');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      !signature ||
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ success: false });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;
    const events = Array.isArray(body?.events) ? body.events : [];

    if (events.length === 0) {
      return res.status(200).json({ success: true });
    }

    let accessToken = null;

    for (const event of events) {
      if (
        event?.type !== 'message' ||
        event?.message?.type !== 'text' ||
        !event?.replyToken
      ) {
        continue;
      }

      const text = String(event.message.text || '').trim();
      const userId = String(event?.source?.userId || '');

      if (
        !['線上預訂', 'testorder'].includes(text.toLowerCase()) ||
        !/^U[0-9a-f]{32}$/i.test(userId)
      ) {
        continue;
      }

      if (!accessToken) {
        accessToken = await getLineAccessToken();
      }

      const session = createOrderSession(userId);
      const orderLink = ORDER_URL + '?session=' + encodeURIComponent(session);

      await replyLineOrderLink(
        accessToken,
        event.replyToken,
        orderLink
      );
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error(
      'LINE webhook error:',
      String(error?.message || 'unknown').slice(0, 200)
    );
    return res.status(500).json({ success: false });
  }
};

function createOrderSession(userId) {
  const key = crypto
    .createHash('sha256')
    .update(ORDER_SESSION_SECRET)
    .digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      expiresAt: Date.now() + SESSION_LIFETIME_MS
    }),
    'utf8'
  );
  const encrypted = Buffer.concat([
    cipher.update(payload),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url')
  ].join('.');
}

async function getLineAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: LINE_CHANNEL_ID,
    client_secret: LINE_CHANNEL_SECRET
  });
  const response = await fetch(
    'https://api.line.me/v2/oauth/accessToken',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    }
  );
  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error('Unable to obtain LINE access token');
  }

  return result.access_token;
}

async function replyLineOrderLink(accessToken, replyToken, orderLink) {
  const response = await fetch(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        replyToken,
        messages: [{
          type: 'template',
          altText: '泰泰烤豬串｜線上預訂',
          template: {
            type: 'buttons',
            title: '泰泰烤豬串｜線上預訂',
            text: '請點擊下方按鈕填寫訂單\n連結限本人使用，有效期限 24 小時',
            actions: [{
              type: 'uri',
              label: '開始訂購',
              uri: orderLink
            }]
          }
        }]
      })
    }
  );

  if (!response.ok) {
    throw new Error('Unable to send LINE reply');
  }
}

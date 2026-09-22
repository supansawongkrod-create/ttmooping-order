const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ORDER_SESSION_SECRET = process.env.ORDER_SESSION_SECRET;

const ORDER_URL = 'https://ttmooping-order.vercel.app';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // -----------------------------
    // 1. Verify LINE webhook
    // -----------------------------
    if (!LINE_CHANNEL_SECRET) {
      throw new Error('LINE_CHANNEL_SECRET missing');
    }

    const signature = req.headers['x-line-signature'];

    const rawBody =
      typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac('sha256', LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest('base64');

    if (!signature) {
      return res.status(401).json({ error: 'Missing LINE signature' });
    }

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

    const events = body?.events || [];

    // LINE webhook verification
    if (events.length === 0) {
      return res.status(200).json({ success: true });
    }

    // -----------------------------
    // 2. Handle LINE events
    // -----------------------------
    for (const event of events) {
      const userId = event?.source?.userId;

      if (!userId) continue;

      console.log('EVENT_TYPE:', event.type);

      if (
        event.type === 'message' &&
        event.message?.type === 'text' &&
        event.message.text.trim().toLowerCase() === 'testorder'
      ) {
        console.log('TEST_ORDER_REQUEST');

        const token = createSessionToken();

        // Save token -> LINE user ID
        await saveOrderSession(token, userId);

        const orderLink =
          `${ORDER_URL}/?session=${encodeURIComponent(token)}`;

        // Get temporary LINE access token
        const accessToken = await getLineAccessToken();

        // Reply to the SAME person
        await replyLineMessage(
          accessToken,
          event.replyToken,
          orderLink
        );

        console.log('TEST_ORDER_LINK_SENT');
      }
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({
      success: false,
      error: String(error.message || error)
    });
  }
};


// ======================================================
// Create random order session token
// ======================================================

function createSessionToken() {
  const random = crypto.randomBytes(24).toString('hex');

  return crypto
    .createHmac('sha256', ORDER_SESSION_SECRET)
    .update(random + Date.now())
    .digest('hex');
}


// ======================================================
// Save session to Supabase
// ======================================================

async function saveOrderSession(token, userId) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error('Supabase environment variables missing');
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/order_sessions`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        token: token,
        line_user_id: userId,
        used: false
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Supabase session error ${response.status}: ${text}`
    );
  }
}


// ======================================================
// Get LINE Channel Access Token
// ======================================================

async function getLineAccessToken() {
  if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET) {
    throw new Error('LINE credentials missing');
  }

  const params = new URLSearchParams();

  params.append('grant_type', 'client_credentials');
  params.append('client_id', LINE_CHANNEL_ID);
  params.append('client_secret', LINE_CHANNEL_SECRET);

  const response = await fetch(
    'https://api.line.me/v2/oauth/accessToken',
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      body: params.toString()
    }
  );

  const result = await response.json();

  if (!response.ok || !result.access_token) {
    throw new Error(
      `LINE token error ${response.status}: ${JSON.stringify(result)}`
    );
  }

  return result.access_token;
}


// ======================================================
// Reply with test order link
// ======================================================

async function replyLineMessage(
  accessToken,
  replyToken,
  orderLink
) {
  const response = await fetch(
    'https://api.line.me/v2/bot/message/reply',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        replyToken: replyToken,

        messages: [
          {
            type: 'text',

            text:
              '泰泰烤豬串｜測試訂購\n\n' +
              '請點擊下方連結進入測試訂購頁：\n' +
              orderLink
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      `LINE reply error ${response.status}: ${text}`
    );
  }
}

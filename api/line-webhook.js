const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelSecret) {
    console.error('LINE_CHANNEL_SECRET is missing');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const signature = req.headers['x-line-signature'];

  if (!signature) {
    return res.status(401).json({ error: 'Missing LINE signature' });
  }

  try {
    // Vercel may already parse application/json.
    // Reconstruct the compact JSON body for LINE verification.
    const rawBody =
      typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

    const expectedSignature = crypto
      .createHmac('sha256', channelSecret)
      .update(rawBody)
      .digest('base64');

    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      console.error('Invalid LINE signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const body =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

    const events = body?.events || [];

    // LINE sends events: [] when verifying the webhook URL.
    if (events.length === 0) {
      console.log('LINE webhook verification received');
      return res.status(200).json({ success: true });
    }

    for (const event of events) {
      const userId = event?.source?.userId;

      if (userId) {
        // Temporary: use Vercel Logs to confirm our own test user ID.
        console.log('LINE_USER_ID:', userId);
        console.log('EVENT_TYPE:', event.type);
      }
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook error' });
  }
};

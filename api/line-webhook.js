const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!secret) {
    return res.status(500).json({ error: 'LINE_CHANNEL_SECRET missing' });
  }

  const signature = req.headers['x-line-signature'];

  const rawBody =
    typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  if (
    !signature ||
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const body =
    typeof req.body === 'string'
      ? JSON.parse(req.body)
      : req.body;

  for (const event of body.events || []) {

    const userId = event?.source?.userId;

    if (!userId) continue;

    console.log('LINE_USER_ID:', userId);
    console.log('EVENT_TYPE:', event.type);

    /*
      เมื่อผู้ใช้ส่งข้อความว่า "order" หรือ "สั่งซื้อ"
      เราจะตอบกลับพร้อมลิงก์ Order

      ขั้นถัดไปเราจะเปลี่ยนลิงก์นี้ให้มี session token
      ที่ผูกกับ LINE user อย่างปลอดภัย
    */

    if (
      event.type === 'message' &&
      event.message?.type === 'text'
    ) {
      const text = event.message.text.trim().toLowerCase();

      if (
        text === 'order' ||
        text === 'สั่งซื้อ' ||
        text === '訂購'
      ) {
        console.log('ORDER_REQUEST_FROM:', userId);
      }
    }
  }

  return res.status(200).json({ success: true });
};

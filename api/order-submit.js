const crypto = require('crypto');

const ORDER_APPS_SCRIPT =
  process.env.ORDER_APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbxAgWawSRlh1PsoVEX5UoU-btb0Ia5pKCMWDNYBq5RzBZJ472PO5MNi7IDLwrrFZzwG/exec';

const MAX_REQUEST_BYTES = 2.8 * 1024 * 1024;
const MAX_SLIP_BYTES = 1.9 * 1024 * 1024;
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ORDER_SESSION_SECRET = process.env.ORDER_SESSION_SECRET;
const TRACKING_URL = 'https://ttmooping-ordertracking.vercel.app/';
const LINE_PAY_URL = 'https://reurl.cc/GgNgvA';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const contentLength = Number(req.headers['content-length'] || 0);

    if (contentLength > MAX_REQUEST_BYTES) {
      return res.status(413).json({
        success: false,
        error: 'Request is too large'
      });
    }

    const data =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

    const lineUserId = openOrderSession(data?.session);

    if (
      !data ||
      typeof data !== 'object' ||
      data.action !== 'createOrder'
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request'
      });
    }

    const orderId = clean(data.orderId, 100);
    const lineName = clean(data.lineName, 100);
    const name = clean(data.name, 100);
    const phone = clean(data.phone, 40).replace(/\D/g, '');
    const address = clean(data.address, 500);
    const pork = wholeNumber(data.pork, 0, 100);
    const chicken = wholeNumber(data.chicken, 0, 100);
    const delivery = data.delivery === 'pickup' ? 'pickup' : 'shipping';
    const payment = data.payment === 'linepay' ? 'linepay' : 'bank';
    const slip = String(data.slip || '');

    if (!/^TT\d{10}$/.test(orderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid order ID'
      });
    }

    if (!lineName || !name || !/^09\d{8}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Required customer information is missing'
      });
    }

    if (pork + chicken < 1) {
      return res.status(400).json({
        success: false,
        error: 'Please select at least one product'
      });
    }

    if (delivery === 'shipping' && !address) {
      return res.status(400).json({
        success: false,
        error: 'Shipping address is required'
      });
    }

    if (payment === 'bank' || slip) {
      const slipMatch = slip.match(
        /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i
      );

      if (!slipMatch) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payment image'
        });
      }

      const slipBytes = Buffer.from(slipMatch[2], 'base64').length;

      if (slipBytes < 1 || slipBytes > MAX_SLIP_BYTES) {
        return res.status(413).json({
          success: false,
          error: 'Payment image is too large'
        });
      }
    }

    // Recalculate every amount on the server. Do not trust totals from the browser.
    const productTotal = pork * 300 + chicken * 200;
    const shippingFee = delivery === 'shipping' ? 200 : 0;
    const total = productTotal + shippingFee;

    const safePayload = {
      action: 'createOrder',
      orderId,
      lineName,
      name,
      phone,
      address: delivery === 'shipping' ? address : '工作室自取',
      pork,
      chicken,
      delivery,
      payment,
      productTotal,
      shippingFee,
      total,
      slip
    };

    const orderResponse = await fetch(ORDER_APPS_SCRIPT, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(safePayload),
      redirect: 'follow',
      signal: AbortSignal.timeout(55000)
    });

    const responseText = await orderResponse.text();
    let orderResult = null;

    try {
      orderResult = JSON.parse(responseText);
    } catch (_) {}

    if (
      !orderResponse.ok ||
      !orderResult ||
      orderResult.success !== true
    ) {
      console.error(
        'Apps Script order error:',
        orderResponse.status,
        String(orderResult?.message || 'Invalid response').slice(0, 200)
      );

      return res.status(502).json({
        success: false,
        error: 'Order could not be saved'
      });
    }

    let lineNotificationSent = false;

    if (lineUserId) {
      lineNotificationSent = await sendLineConfirmation(
        lineUserId,
        orderId,
        total,
        pork,
        chicken,
        delivery,
        payment
      );
    }

    return res.status(200).json({
      success: true,
      orderId,
      lineNotificationSent
    });
  } catch (error) {
    console.error(
      'Order submit error:',
      String(error?.message || 'unknown').slice(0, 200)
    );

    return res.status(500).json({
      success: false,
      error: 'Unable to submit order. Please try again.'
    });
  }
};

function clean(value, maxLength) {
  return String(value == null ? '' : value)
    .trim()
    .slice(0, maxLength);
}

function wholeNumber(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function openOrderSession(token) {
  if (!ORDER_SESSION_SECRET || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    return null;
  }

  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const encrypted = Buffer.from(parts[2], 'base64url');
    const key = crypto
      .createHash('sha256')
      .update(ORDER_SESSION_SECRET)
      .digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);

    decipher.setAuthTag(tag);

    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
      ]).toString('utf8')
    );

    if (
      !payload ||
      !/^U[0-9a-f]{32}$/i.test(String(payload.userId || '')) ||
      !Number.isFinite(payload.expiresAt) ||
      Date.now() > payload.expiresAt
    ) {
      return null;
    }

    return payload.userId;
  } catch (_) {
    return null;
  }
}

async function sendLineConfirmation(
  userId,
  orderId,
  total,
  pork,
  chicken,
  delivery,
  payment
) {
  if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET) {
    return false;
  }

  try {
    const accessToken = await getLineAccessToken();
    const productLines = [];

    if (pork > 0) {
      productLines.push('・泰泰烤豬串 × ' + pork + ' 包');
    }

    if (chicken > 0) {
      productLines.push('・泰國生烤雞翅 × ' + chicken + ' 包');
    }

    const deliveryText =
      delivery === 'shipping'
        ? '📦 商品預計於訂購後 7 天內出貨，寄出後約 1–3 個工作天送達。'
        : '📍 請透過官方 LINE 預約工作室自取時間。';

    const linePayPending = payment === 'linepay';
    const messages = [{
      type: 'text',
      text:
        (linePayPending ? '✅ 訂單資料已確認\n\n' : '✅ 訂單已收到\n\n') +
        '訂單編號：' + orderId + '\n\n' +
        '訂購內容：\n' +
        productLines.join('\n') + '\n\n' +
        '應付金額：NT$' + total.toLocaleString('en-US') + '\n\n' +
        (linePayPending
          ? '請點擊下方按鈕前往 LINE Pay，並依照以上金額完成付款。'
          : deliveryText + '\n\n感謝您的訂購！🧡')
    }];

    if (linePayPending) {
      messages.push({
        type: 'template',
        altText: '前往 LINE Pay 付款',
        template: {
          type: 'buttons',
          text: '應付 NT$' + total.toLocaleString('en-US') + '，付款後訂單才正式成立。',
          actions: [{
            type: 'uri',
            label: '前往 LINE Pay',
            uri: LINE_PAY_URL
          }]
        }
      });
    }

    if (!linePayPending && delivery === 'shipping') {
      messages.push({
        type: 'template',
        altText: '查詢宅配單號',
        template: {
          type: 'buttons',
          text: '商品寄出後，可使用手機號碼查詢宅配單號。',
          actions: [{
            type: 'uri',
            label: '查詢宅配單號',
            uri: TRACKING_URL
          }]
        }
      });
    }

    const response = await fetch(
      'https://api.line.me/v2/bot/message/push',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: userId,
          messages
        })
      }
    );

    return response.ok;
  } catch (error) {
    console.error(
      'LINE confirmation error:',
      String(error?.message || 'unknown').slice(0, 160)
    );
    return false;
  }
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

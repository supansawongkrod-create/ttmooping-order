const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const ORDER_APPS_SCRIPT =
  'https://script.google.com/macros/s/AKfycbxAgWawSRlh1PsoVEX5UoU-btb0Ia5pKCMWDNYBq5RzBZJ472PO5MNi7IDLwrrFZzwG/exec';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      throw new Error('Supabase environment variables missing');
    }

    if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET) {
      throw new Error('LINE environment variables missing');
    }

    const data =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

    const session = String(data?.session || '').trim();

    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Missing order session'
      });
    }

    // -------------------------------------------
    // 1. Find LINE user from session
    // -------------------------------------------

    const sessionResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/order_sessions?token=eq.${encodeURIComponent(
        session
      )}&select=token,line_user_id,created_at,used&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`
        }
      }
    );

    if (!sessionResponse.ok) {
      throw new Error(
        `Supabase lookup error ${sessionResponse.status}: ${await sessionResponse.text()}`
      );
    }

    const sessions = await sessionResponse.json();
    const orderSession = sessions[0];

    if (!orderSession) {
      return res.status(401).json({
        success: false,
        error: 'Invalid order session'
      });
    }

    if (orderSession.used) {
      return res.status(409).json({
        success: false,
        error: 'This order link has already been used'
      });
    }

    if (!orderSession.line_user_id) {
      return res.status(401).json({
        success: false,
        error: 'LINE account is not linked to this session'
      });
    }

    // Session valid for 24 hours
    const ageMs =
      Date.now() -
      new Date(orderSession.created_at).getTime();

    if (
      !Number.isFinite(ageMs) ||
      ageMs > 24 * 60 * 60 * 1000
    ) {
      return res.status(401).json({
        success: false,
        error: 'Order session expired'
      });
    }

    // -------------------------------------------
    // 2. Send order to existing Apps Script
    // -------------------------------------------

    const orderPayload = { ...data };

    // Never send session token to Google Sheet
    delete orderPayload.session;

    const orderResponse = await fetch(
      ORDER_APPS_SCRIPT,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'text/plain;charset=utf-8'
        },
        body: JSON.stringify(orderPayload),
        redirect: 'follow'
      }
    );

    const orderText =
      await orderResponse.text();

    let orderResult = {};

    try {
      orderResult = JSON.parse(orderText);
    } catch (_) {}

    if (
      !orderResponse.ok ||
      orderResult.success !== true
    ) {
      throw new Error(
        `Order backend failed ${orderResponse.status}: ${orderText.slice(
          0,
          500
        )}`
      );
    }

    // -------------------------------------------
    // 3. Mark session as used
    // -------------------------------------------

    const usedResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/order_sessions?token=eq.${encodeURIComponent(
        session
      )}&used=eq.false`,
      {
        method: 'PATCH',

        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization:
            `Bearer ${SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },

        body: JSON.stringify({
          used: true
        })
      }
    );

    if (!usedResponse.ok) {
      throw new Error(
        `Supabase update error ${usedResponse.status}: ${await usedResponse.text()}`
      );
    }

    // -------------------------------------------
    // 4. Send LINE confirmation
    // -------------------------------------------

    let lineSent = false;

    try {
      const accessToken =
        await getLineAccessToken();

      await pushOrderConfirmation(
        accessToken,
        orderSession.line_user_id,
        data
      );

      lineSent = true;

    } catch (lineError) {
      /*
        Order is already saved.
        Do NOT make customer submit again
        just because LINE notification failed.
      */

      console.error(
        'LINE confirmation failed:',
        lineError
      );
    }

    return res.status(200).json({
      success: true,
      orderId: data.orderId,
      lineSent: lineSent
    });

  } catch (error) {
    console.error(
      'Order submit error:',
      error
    );

    return res.status(500).json({
      success: false,
      error: String(
        error.message || error
      )
    });
  }
};


// =============================================
// LINE ACCESS TOKEN
// =============================================

async function getLineAccessToken() {
  const params =
    new URLSearchParams({
      grant_type:
        'client_credentials',

      client_id:
        LINE_CHANNEL_ID,

      client_secret:
        LINE_CHANNEL_SECRET
    });

  const response = await fetch(
    'https://api.line.me/v2/oauth/accessToken',
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },

      body:
        params.toString()
    }
  );

  const result =
    await response.json();

  if (
    !response.ok ||
    !result.access_token
  ) {
    throw new Error(
      `LINE token error ${response.status}: ${JSON.stringify(
        result
      )}`
    );
  }

  return result.access_token;
}


// =============================================
// SEND ORDER CONFIRMATION
// =============================================

async function pushOrderConfirmation(
  accessToken,
  userId,
  data
) {
  const delivery =
    data.delivery === 'shipping'
      ? '黑貓冷凍宅配'
      : '台中工作室自取';

  const total =
    Number(
      data.total || 0
    ).toLocaleString('en-US');

  const text =
    `🐘 泰泰烤豬串\n\n` +
    `已收到您的訂單！\n` +
    `訂單編號：${String(
      data.orderId || ''
    )}\n` +
    `訂單金額：NT$${total}\n` +
    `配送方式：${delivery}\n\n` +
    `付款證明已收到，店家核對款項後訂單才會正式成立。\n` +
    `感謝您的訂購 ❤️`;

  const response = await fetch(
    'https://api.line.me/v2/bot/message/push',
    {
      method: 'POST',

      headers: {
        Authorization:
          `Bearer ${accessToken}`,

        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({
        to: userId,

        messages: [
          {
            type: 'text',
            text: text
          }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `LINE push error ${response.status}: ${await response.text()}`
    );
  }
}

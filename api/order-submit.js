const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const ORDER_APPS_SCRIPT =
  'https://script.google.com/macros/s/AKfycbxAgWawSRlh1PsoVEX5UoU-btb0Ia5pKCMWDNYBq5RzBZJ472PO5MNi7IDLwrrFZzwG/exec';

const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_REQUEST_BYTES = 2.8 * 1024 * 1024;

module.exports = async function handler(req, res) {
  const totalStart = Date.now();

  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    // ==================================================
    // 0. SERVER CONFIG
    // ==================================================

    if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
      throw new Error('Supabase configuration missing');
    }

    if (!LINE_CHANNEL_ID || !LINE_CHANNEL_SECRET) {
      throw new Error('LINE configuration missing');
    }

    const contentLength = Number(
      req.headers['content-length'] || 0
    );

    if (
      contentLength &&
      contentLength > MAX_REQUEST_BYTES
    ) {
      return res.status(413).json({
        success: false,
        error: 'Payment image is too large'
      });
    }

    const data =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Invalid request'
      });
    }

    const session = clean(data.session, 200);
    const orderId = clean(data.orderId, 100);

    if (!session) {
      return res.status(400).json({
        success: false,
        error: 'Missing order session'
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'Missing order ID'
      });
    }

    // ==================================================
    // 1. SESSION LOOKUP
    // ==================================================

    const sessionStart = Date.now();

    const sessionResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/order_sessions` +
        `?token=eq.${encodeURIComponent(session)}` +
        `&select=token,line_user_id,created_at,used&limit=1`,
      {
        headers: supabaseHeaders()
      }
    );

    if (!sessionResponse.ok) {
      throw new Error(
        `Session lookup HTTP ${sessionResponse.status}`
      );
    }

    const sessions = await sessionResponse.json();
    const orderSession = sessions[0];

    console.log(
      `[TIMING] Session lookup: ${
        Date.now() - sessionStart
      } ms`
    );

    if (!orderSession) {
      return res.status(401).json({
        success: false,
        error: 'Invalid order link'
      });
    }

    if (orderSession.used === true) {
      return res.status(409).json({
        success: false,
        error: 'This order link has already been used'
      });
    }

    if (!orderSession.line_user_id) {
      return res.status(401).json({
        success: false,
        error: 'Invalid order link'
      });
    }

    const createdAt =
      new Date(orderSession.created_at).getTime();

    const age =
      Date.now() - createdAt;

    if (
      !Number.isFinite(createdAt) ||
      age < 0 ||
      age > SESSION_MAX_AGE_MS
    ) {
      return res.status(401).json({
        success: false,
        error: 'Order link expired'
      });
    }

    // ==================================================
    // 2. PREPARE SAFE ORDER PAYLOAD
    // ==================================================

    const safePayload = {
      action: 'createOrder',

      orderId: orderId,

      lineName: clean(data.lineName, 100),
      name: clean(data.name, 100),
      phone: clean(data.phone, 40),
      address: clean(data.address, 500),

      pork: numberOrZero(data.pork),
      chicken: numberOrZero(data.chicken),

      delivery:
        data.delivery === 'pickup'
          ? 'pickup'
          : 'shipping',

      payment:
        data.payment === 'linepay'
          ? 'linepay'
          : 'bank',

      productTotal:
        numberOrZero(data.productTotal),

      shippingFee:
        numberOrZero(data.shippingFee),

      total:
        numberOrZero(data.total),

      slip:
        String(data.slip || '')
    };

    if (
      !safePayload.name ||
      !safePayload.phone ||
      !safePayload.slip
    ) {
      return res.status(400).json({
        success: false,
        error: 'Required order information is missing'
      });
    }

    if (
      !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(
        safePayload.slip
      )
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment image'
      });
    }

    // ==================================================
    // 3. APPS SCRIPT + DRIVE + SHEET
    // ==================================================

    const appsScriptStart = Date.now();

    const orderResponse = await fetch(
      ORDER_APPS_SCRIPT,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'text/plain;charset=utf-8'
        },

        body:
          JSON.stringify(safePayload),

        redirect: 'follow'
      }
    );

    const orderText =
      await orderResponse.text();

    console.log(
      `[TIMING] Apps Script + Drive + Sheet: ${
        Date.now() - appsScriptStart
      } ms`
    );

    let orderResult = null;

    try {
      orderResult =
        JSON.parse(orderText);
    } catch (_) {}

    if (
      !orderResponse.ok ||
      !orderResult ||
      orderResult.success !== true
    ) {
      console.error(
        'Order backend failed:',
        orderResponse.status
      );

      throw new Error(
        'Order could not be saved'
      );
    }

    // ==================================================
    // 4. MARK SESSION AS USED
    // ==================================================

    const sessionUpdateStart =
      Date.now();

    const usedResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/order_sessions` +
        `?token=eq.${encodeURIComponent(session)}` +
        `&used=eq.false`,
      {
        method: 'PATCH',

        headers: {
          ...supabaseHeaders(),

          'Content-Type':
            'application/json',

          Prefer:
            'return=minimal'
        },

        body: JSON.stringify({
          used: true
        })
      }
    );

    console.log(
      `[TIMING] Session update: ${
        Date.now() - sessionUpdateStart
      } ms`
    );

    if (!usedResponse.ok) {
      /*
        Order is already saved.
        Don't expose customer data
        and don't ask them to submit again.
      */

      console.error(
        'Session update failed:',
        usedResponse.status
      );
    }

    // ==================================================
    // 5. LINE CONFIRMATION
    //
    // IMPORTANT:
    // Wait for LINE before returning response.
    // This prevents Vercel from terminating the
    // function before the message is sent.
    // ==================================================

    const lineStart = Date.now();

    let lineSent = false;

    try {
      const accessToken =
        await getLineAccessToken();

      await pushOrderConfirmation(
        accessToken,
        orderSession.line_user_id,
        safePayload
      );

      lineSent = true;

      console.log(
        `[TIMING] LINE: ${
          Date.now() - lineStart
        } ms`
      );

    } catch (lineError) {
      /*
        Order has already been saved.
        LINE failure must NOT cause customer
        to submit the order again.
      */

      console.error(
        'LINE confirmation failed:',
        String(
          lineError?.message ||
          'unknown'
        )
      );

      console.log(
        `[TIMING] LINE failed after: ${
          Date.now() - lineStart
        } ms`
      );
    }

    // ==================================================
    // 6. FINISH
    // ==================================================

    console.log(
      `[TIMING] TOTAL: ${
        Date.now() - totalStart
      } ms`
    );

    return res.status(200).json({
      success: true,
      orderId: orderId,
      lineSent: lineSent
    });

  } catch (error) {

    console.error(
      'Order submit error:',
      String(
        error?.message ||
        'unknown'
      )
    );

    console.log(
      `[TIMING] FAILED TOTAL: ${
        Date.now() - totalStart
      } ms`
    );

    return res.status(500).json({
      success: false,
      error:
        'Unable to submit order. Please try again.'
    });
  }
};


// ======================================================
// LINE ACCESS TOKEN
// ======================================================

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

  const response =
    await fetch(
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
      `LINE token HTTP ${response.status}`
    );
  }

  return result.access_token;
}


// ======================================================
// LINE PUSH
// ======================================================

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
    `訂單編號：${data.orderId}\n` +
    `訂單金額：NT$${total}\n` +
    `配送方式：${delivery}\n\n` +
    `付款證明已收到，店家核對款項後訂單才會正式成立。\n` +
    `感謝您的訂購 ❤️`;

  const response =
    await fetch(
      'https://api.line.me/v2/bot/message/push',
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
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
      `LINE push HTTP ${response.status}`
    );
  }
}


// ======================================================
// HELPERS
// ======================================================

function supabaseHeaders() {
  return {
    apikey:
      SUPABASE_SECRET_KEY,

    Authorization:
      `Bearer ${SUPABASE_SECRET_KEY}`
  };
}


function clean(
  value,
  maxLength
) {
  return String(
    value == null
      ? ''
      : value
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}


function numberOrZero(value) {
  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

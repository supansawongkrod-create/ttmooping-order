const { waitUntil } = require('@vercel/functions');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const ORDER_APPS_SCRIPT =
  'https://script.google.com/macros/s/AKfycbxAgWawSRlh1PsoVEX5UoU-btb0Ia5pKCMWDNYBq5RzBZJ472PO5MNi7IDLwrrFZzwG/exec';

const STORAGE_BUCKET = 'payment-slips';

const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_SLIP_BYTES = 1.9 * 1024 * 1024;


// ======================================================
// MAIN
// ======================================================

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
    // 1. CHECK SESSION
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
    // 2. PREPARE ORDER
    // ==================================================

    const safePayload = {
      action: 'createOrder',

      orderId,

      lineName:
        clean(data.lineName, 100),

      name:
        clean(data.name, 100),

      phone:
        clean(data.phone, 40),

      address:
        clean(data.address, 500),

      pork:
        numberOrZero(data.pork),

      chicken:
        numberOrZero(data.chicken),

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


    // ==================================================
    // 3. PAYMENT SLIP
    // ==================================================

    const slipMatch =
      safePayload.slip.match(
        /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i
      );

    if (!slipMatch) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment image'
      });
    }

    const imageType =
      slipMatch[1].toLowerCase();

    const mimeType =
      imageType === 'jpg'
        ? 'image/jpeg'
        : `image/${imageType}`;

    const extension =
      imageType === 'jpeg'
        ? 'jpg'
        : imageType;

    const slipBuffer =
      Buffer.from(
        slipMatch[2],
        'base64'
      );

    if (slipBuffer.length > MAX_SLIP_BYTES) {
      return res.status(413).json({
        success: false,
        error: 'Payment image is too large'
      });
    }


    // ==================================================
    // 4. STORE SLIP IN PRIVATE SUPABASE STORAGE
    // ==================================================

    const storageStart = Date.now();

    const safeFileOrderId =
      orderId.replace(
        /[^A-Za-z0-9_-]/g,
        ''
      );

    const slipPath =
      `${safeFileOrderId}-${Date.now()}.${extension}`;

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/` +
      `${STORAGE_BUCKET}/` +
      `${encodeURIComponent(slipPath)}`,
      {
        method: 'POST',

        headers: {
          ...supabaseHeaders(),

          'Content-Type': mimeType,

          'x-upsert': 'false'
        },

        body: slipBuffer
      }
    );

    if (!uploadResponse.ok) {
      const uploadError =
        await uploadResponse.text();

      console.error(
        'Storage upload failed:',
        uploadResponse.status,
        uploadError.slice(0, 200)
      );

      throw new Error(
        'Payment image could not be stored'
      );
    }

    console.log(
      `[TIMING] Storage upload: ${
        Date.now() - storageStart
      } ms`
    );


    // ==================================================
    // 5. SAVE ORDER IN SUPABASE
    // ==================================================

    const databaseStart = Date.now();

    const databaseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/orders`,
      {
        method: 'POST',

        headers: {
          ...supabaseHeaders(),

          'Content-Type': 'application/json',

          Prefer: 'return=minimal'
        },

        body: JSON.stringify({
          order_id: orderId,

          line_user_id:
            orderSession.line_user_id,

          line_name:
            safePayload.lineName,

          customer_name:
            safePayload.name,

          phone:
            safePayload.phone,

          address:
            safePayload.address,

          pork:
            safePayload.pork,

          chicken:
            safePayload.chicken,

          delivery:
            safePayload.delivery,

          payment:
            safePayload.payment,

          product_total:
            safePayload.productTotal,

          shipping_fee:
            safePayload.shippingFee,

          total:
            safePayload.total,

          slip_path:
            slipPath,

          synced_to_sheet:
            false,

          line_sent:
            false
        })
      }
    );

    if (!databaseResponse.ok) {
      const databaseError =
        await databaseResponse.text();

      console.error(
        'Order database failed:',
        databaseResponse.status,
        databaseError.slice(0, 200)
      );

      await deleteStorageFile(
        slipPath
      ).catch(() => {});

      if (databaseResponse.status === 409) {
        return res.status(409).json({
          success: false,
          error: 'This order has already been submitted'
        });
      }

      throw new Error(
        'Order could not be stored'
      );
    }

    console.log(
      `[TIMING] Supabase order insert: ${
        Date.now() - databaseStart
      } ms`
    );


    // ==================================================
    // 6. MARK SESSION USED
    // ==================================================

    const sessionUpdateStart = Date.now();

    const usedResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/order_sessions` +
      `?token=eq.${encodeURIComponent(session)}` +
      `&used=eq.false`,
      {
        method: 'PATCH',

        headers: {
          ...supabaseHeaders(),

          'Content-Type': 'application/json',

          Prefer: 'return=minimal'
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
      console.error(
        'Session update failed:',
        usedResponse.status
      );
    }


    // ==================================================
    // 7. BACKGROUND
    // ==================================================

    waitUntil(
      processOrderInBackground({
        orderId,

        lineUserId:
          orderSession.line_user_id,

        payload:
          safePayload,

        slipPath,

        mimeType
      })
    );


    // ==================================================
    // 8. CUSTOMER RESPONSE
    // ==================================================

    console.log(
      `[TIMING] CUSTOMER RESPONSE: ${
        Date.now() - totalStart
      } ms`
    );

    return res.status(200).json({
      success: true,
      orderId: orderId
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
      `[TIMING] FAILED: ${
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
// BACKGROUND PROCESSING
// ======================================================

async function processOrderInBackground({
  orderId,
  lineUserId,
  payload,
  slipPath,
  mimeType
}) {
  const start = Date.now();

  let sheetSuccess = false;
  let lineSuccess = false;


  // ====================================================
  // A. GOOGLE SHEET + DRIVE
  //
  // IMPORTANT:
  // Google failure does NOT stop LINE.
  // ====================================================

  try {

    const googleStart = Date.now();

    const downloadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/authenticated/` +
      `${STORAGE_BUCKET}/` +
      `${encodeURIComponent(slipPath)}`,
      {
        headers: supabaseHeaders()
      }
    );

    if (!downloadResponse.ok) {
      const downloadError =
        await downloadResponse.text();

      throw new Error(
        `Storage download HTTP ${downloadResponse.status}: ` +
        downloadError.slice(0, 300)
      );
    }

    const imageBuffer =
      Buffer.from(
        await downloadResponse.arrayBuffer()
      );

    const slipDataUrl =
      `data:${mimeType};base64,` +
      imageBuffer.toString('base64');

    const appsPayload = {
      ...payload,
      slip: slipDataUrl
    };

    const orderResponse = await fetch(
      ORDER_APPS_SCRIPT,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'text/plain;charset=utf-8'
        },

        body:
          JSON.stringify(appsPayload),

        redirect: 'follow'
      }
    );

    const orderText =
      await orderResponse.text();

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

      const googleMessage =
        orderResult &&
        orderResult.message

          ? String(
              orderResult.message
            ).slice(0, 300)

          : 'Invalid Apps Script response';

      throw new Error(
        `Google order failed - HTTP ${orderResponse.status} - ${googleMessage}`
      );
    }

    sheetSuccess = true;

    console.log(
      `[BACKGROUND] Google Sheet + Drive: ${
        Date.now() - googleStart
      } ms`
    );

  } catch (googleError) {

    console.error(
      '[BACKGROUND] GOOGLE FAILED:',
      String(
        googleError?.message ||
        'unknown'
      )
    );

    /*
      Do NOT delete the temporary slip.

      Order and slip stay safely in Supabase
      so they can be recovered/retried.
    */
  }


  // ====================================================
  // B. LINE
  //
  // LINE runs regardless of Google result.
  // ====================================================

  try {

    const lineStart = Date.now();

    const accessToken =
      await getLineAccessToken();

    await pushOrderConfirmation(
      accessToken,
      lineUserId,
      payload
    );

    lineSuccess = true;

    console.log(
      `[BACKGROUND] LINE: ${
        Date.now() - lineStart
      } ms`
    );

  } catch (lineError) {

    console.error(
      '[BACKGROUND] LINE FAILED:',
      String(
        lineError?.message ||
        'unknown'
      )
    );
  }


  // ====================================================
  // C. UPDATE STATUS
  // ====================================================

  try {

    await updateOrderStatus(
      orderId,
      {
        synced_to_sheet:
          sheetSuccess,

        line_sent:
          lineSuccess
      }
    );

  } catch (statusError) {

    console.error(
      '[BACKGROUND] STATUS UPDATE FAILED:',
      String(
        statusError?.message ||
        'unknown'
      )
    );
  }


  // ====================================================
  // D. DELETE TEMP STORAGE COPY
  //
  // Only after Google successfully saved the slip.
  // ====================================================

  if (sheetSuccess) {

    try {

      const deleted =
        await deleteStorageFile(
          slipPath
        );

      if (deleted) {

        await updateOrderStatus(
          orderId,
          {
            slip_path:
              null
          }
        );
      }

    } catch (cleanupError) {

      console.error(
        '[BACKGROUND] STORAGE CLEANUP FAILED:',
        String(
          cleanupError?.message ||
          'unknown'
        )
      );
    }
  }


  console.log(
    `[BACKGROUND] COMPLETE: ${
      Date.now() - start
    } ms | sheet=${sheetSuccess} | line=${lineSuccess}`
  );
}


// ======================================================
// UPDATE ORDER STATUS
// ======================================================

async function updateOrderStatus(
  orderId,
  values
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/orders` +
    `?order_id=eq.${encodeURIComponent(orderId)}`,
    {
      method: 'PATCH',

      headers: {
        ...supabaseHeaders(),

        'Content-Type':
          'application/json',

        Prefer:
          'return=minimal'
      },

      body:
        JSON.stringify(values)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Order status update HTTP ${response.status}`
    );
  }
}


// ======================================================
// DELETE TEMPORARY STORAGE FILE
// ======================================================

async function deleteStorageFile(
  slipPath
) {
  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/` +
    `${STORAGE_BUCKET}/` +
    `${encodeURIComponent(slipPath)}`,
    {
      method: 'DELETE',

      headers:
        supabaseHeaders()
    }
  );

  if (!response.ok) {

    console.error(
      'Storage cleanup failed:',
      response.status
    );

    return false;
  }

  return true;
}


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
      `LINE token HTTP ${response.status}`
    );
  }

  return result.access_token;
}


// ======================================================
// LINE CONFIRMATION
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

    const lineError =
      await response.text();

    throw new Error(
      `LINE push HTTP ${response.status}: ` +
      lineError.slice(0, 300)
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

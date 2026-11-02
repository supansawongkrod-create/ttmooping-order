const ORDER_APPS_SCRIPT =
  process.env.ORDER_APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbxAgWawSRlh1PsoVEX5UoU-btb0Ia5pKCMWDNYBq5RzBZJ472PO5MNi7IDLwrrFZzwG/exec';

const MAX_REQUEST_BYTES = 2.8 * 1024 * 1024;
const MAX_SLIP_BYTES = 1.9 * 1024 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    const contentLength = Number(
      req.headers['content-length'] || 0
    );

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

    const phone = clean(data.phone, 40)
      .replace(/\D/g, '');

    const address = clean(data.address, 500);
    const pork = wholeNumber(data.pork, 0, 100);
    const chicken = wholeNumber(data.chicken, 0, 100);

    const delivery =
      data.delivery === 'pickup'
        ? 'pickup'
        : 'shipping';

    const payment =
      data.payment === 'linepay'
        ? 'linepay'
        : 'bank';

    const slip = String(data.slip || '');

    if (!/^TT\d{10}$/.test(orderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid order ID'
      });
    }

    if (
      !lineName ||
      !name ||
      !/^09\d{8}$/.test(phone)
    ) {
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

    if (
      delivery === 'shipping' &&
      !address
    ) {
      return res.status(400).json({
        success: false,
        error: 'Shipping address is required'
      });
    }

    const slipMatch = slip.match(
      /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i
    );

    if (!slipMatch) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment image'
      });
    }

    const slipBytes = Buffer.from(
      slipMatch[2],
      'base64'
    ).length;

    if (
      slipBytes < 1 ||
      slipBytes > MAX_SLIP_BYTES
    ) {
      return res.status(413).json({
        success: false,
        error: 'Payment image is too large'
      });
    }

    // คำนวณยอดใหม่ที่เซิร์ฟเวอร์
    const productTotal =
      pork * 300 +
      chicken * 200;

    const shippingFee =
      delivery === 'shipping'
        ? 200
        : 0;

    const total =
      productTotal +
      shippingFee;

    const safePayload = {
      action: 'createOrder',
      orderId,
      lineName,
      name,
      phone,

      address:
        delivery === 'shipping'
          ? address
          : '工作室自取',

      pork,
      chicken,
      delivery,
      payment,
      productTotal,
      shippingFee,
      total,
      slip
    };

    const orderResponse = await fetch(
      ORDER_APPS_SCRIPT,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'text/plain;charset=utf-8'
        },

        body: JSON.stringify(safePayload),
        redirect: 'follow',
        signal: AbortSignal.timeout(55000)
      }
    );

    const responseText =
      await orderResponse.text();

    let orderResult = null;

    try {
      orderResult =
        JSON.parse(responseText);
    } catch (_) {}

    if (
      !orderResponse.ok ||
      !orderResult ||
      orderResult.success !== true
    ) {
      console.error(
        'Apps Script order error:',
        orderResponse.status,
        String(
          orderResult?.message ||
          'Invalid response'
        ).slice(0, 200)
      );

      return res.status(502).json({
        success: false,
        error: 'Order could not be saved'
      });
    }

    return res.status(200).json({
      success: true,
      orderId
    });

  } catch (error) {
    console.error(
      'Order submit error:',
      String(
        error?.message ||
        'unknown'
      ).slice(0, 200)
    );

    return res.status(500).json({
      success: false,
      error:
        'Unable to submit order. Please try again.'
    });
  }
};

function clean(value, maxLength) {
  return String(
    value == null
      ? ''
      : value
  )
    .trim()
    .slice(0, maxLength);
}

function wholeNumber(
  value,
  min,
  max
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(
    max,
    Math.max(
      min,
      Math.trunc(number)
    )
  );
}

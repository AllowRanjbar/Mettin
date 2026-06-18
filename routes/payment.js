const express = require('express');
const axios = require('axios');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
require('dotenv').config();

const router = express.Router();

// ZarinPal payment request
router.post('/request', authenticate, async (req, res) => {
  try {
    const { shipping_address, phone, notes } = req.body;

    // Get cart items
    const [cartItems] = await pool.query(
      `SELECT ci.*, p.name_fa, p.name_en, p.price, p.sale_price
       FROM cart_items ci JOIN products p ON ci.product_id = p.id
       WHERE ci.user_id = ?`,
      [req.user.id]
    );

    if (cartItems.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    let totalAmount = 0;
    const items = cartItems.map(item => {
      const price = item.sale_price || item.price;
      totalAmount += price * item.quantity;
      return {
        product_id: item.product_id,
        product_name_fa: item.name_fa,
        product_name_en: item.name_en,
        price,
        quantity: item.quantity
      };
    });

    const merchantId = process.env.ZARINPAL_MERCHANT_ID || '00000000-0000-0000-0000-000000000000';
    const callbackUrl = process.env.ZARINPAL_CALLBACK_URL || 'http://localhost:5000/api/payment/verify';
    const amount = totalAmount;
    const description = `پرداخت سفارش ${req.user.name}`;

    // Store pending order info in a temp way (we'll create the order after payment)
    // Store in a global map or DB - using a simple approach
    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    // Save temporary order data
    const tempOrder = {
      user_id: req.user.id,
      orderNumber,
      totalAmount: amount,
      shipping_address,
      phone,
      notes,
      items: JSON.stringify(items),
      createdAt: Date.now()
    };

    // Store in a temp table or just pass via the authority
    // For simplicity, we'll store order_number in a temp way
    await pool.query(
      `INSERT INTO orders (user_id, order_number, total_amount, shipping_address, phone, notes, status, payment_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending')`,
      [req.user.id, orderNumber, amount, shipping_address, phone, notes]
    );

    const [orderResult] = await pool.query(
      'SELECT id FROM orders WHERE order_number = ?',
      [orderNumber]
    );
    const orderId = orderResult[0].id;

    // Insert order items as pending
    for (const item of items) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, product_name_fa, product_name_en, price, quantity, total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.product_name_fa, item.product_name_en, item.price, item.quantity, item.price * item.quantity]
      );
    }

    // Call ZarinPal API
    const zarinpalResponse = await axios.post('https://api.zarinpal.com/pg/v4/payment/request.json', {
      merchant_id: merchantId,
      amount,
      description,
      callback_url: callbackUrl,
      metadata: {
        order_number: orderNumber,
        email: req.user.email,
        phone
      }
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (zarinpalResponse.data.data.code === 100) {
      const authority = zarinpalResponse.data.data.authority;
      // Save authority to order
      await pool.query('UPDATE orders SET payment_ref_id = ? WHERE id = ?', [authority, orderId]);

      res.json({
        authority,
        payment_url: `https://www.zarinpal.com/pg/StartPay/${authority}`,
        order_number: orderNumber,
        amount
      });
    } else {
      // Remove temp order on failure
      await pool.query('DELETE FROM orders WHERE id = ?', [orderId]);
      await pool.query('DELETE FROM order_items WHERE order_id = ?', [orderId]);
      res.status(400).json({
        message: 'Payment request failed',
        errors: zarinpalResponse.data.errors
      });
    }
  } catch (err) {
    console.error('Payment request error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Payment request failed' });
  }
});

// ZarinPal payment verification (callback)
router.get('/verify', async (req, res) => {
  try {
    const { Authority, Status } = req.query;

    if (Status !== 'OK') {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/result?status=failed`);
    }

    // Find order by authority
    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE payment_ref_id = ?',
      [Authority]
    );

    if (orders.length === 0) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/result?status=failed`);
    }

    const order = orders[0];

    // Verify with ZarinPal
    const merchantId = process.env.ZARINPAL_MERCHANT_ID || '00000000-0000-0000-0000-000000000000';
    const verifyResponse = await axios.post('https://api.zarinpal.com/pg/v4/payment/verify.json', {
      merchant_id: merchantId,
      amount: order.total_amount,
      authority: Authority
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    if (verifyResponse.data.data.code === 100) {
      const refId = verifyResponse.data.data.ref_id;

      // Update order status
      await pool.query(
        'UPDATE orders SET payment_status = ?, status = ?, payment_ref_id = ?, paid_at = NOW() WHERE id = ?',
        ['paid', 'processing', refId, order.id]
      );

      // Clear user's cart
      await pool.query('DELETE FROM cart_items WHERE user_id = ?', [order.user_id]);

      return res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/result?status=success&ref_id=${refId}&order_number=${order.order_number}`
      );
    } else {
      await pool.query(
        'UPDATE orders SET payment_status = ?, status = ? WHERE id = ?',
        ['failed', 'cancelled', order.id]
      );
      return res.redirect(
        `${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/result?status=failed`
      );
    }
  } catch (err) {
    console.error('Payment verify error:', err.response?.data || err.message);
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/checkout/result?status=error`);
  }
});

module.exports = router;

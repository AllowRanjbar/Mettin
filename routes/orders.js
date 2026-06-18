const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// Create order (after successful payment)
router.post('/', authenticate, async (req, res) => {
  try {
    const { shipping_address, phone, notes, payment_ref_id } = req.body;

    // Get user's cart items
    const [cartItems] = await pool.query(
      `SELECT ci.*, p.name_fa, p.name_en, p.price, p.sale_price
       FROM cart_items ci
       JOIN products p ON ci.product_id = p.id
       WHERE ci.user_id = ?`,
      [req.user.id]
    );

    if (cartItems.length === 0) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    const orderNumber = 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    let totalAmount = 0;

    const orderItems = cartItems.map(item => {
      const price = item.sale_price || item.price;
      const total = price * item.quantity;
      totalAmount += total;
      return {
        product_id: item.product_id,
        product_name_fa: item.name_fa,
        product_name_en: item.name_en,
        price,
        quantity: item.quantity,
        total
      };
    });

    // Create order
    const [orderResult] = await pool.query(
      `INSERT INTO orders (user_id, order_number, total_amount, shipping_address, phone, notes, payment_ref_id, payment_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', 'processing')`,
      [req.user.id, orderNumber, totalAmount, shipping_address, phone, notes, payment_ref_id]
    );

    const orderId = orderResult.insertId;

    // Insert order items
    for (const item of orderItems) {
      await pool.query(
        `INSERT INTO order_items (order_id, product_id, product_name_fa, product_name_en, price, quantity, total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orderId, item.product_id, item.product_name_fa, item.product_name_en, item.price, item.quantity, item.total]
      );
    }

    // Clear user's cart
    await pool.query('DELETE FROM cart_items WHERE user_id = ?', [req.user.id]);

    res.status(201).json({ orderId, orderNumber, totalAmount });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get user orders
router.get('/', authenticate, async (req, res) => {
  try {
    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );

    for (const order of orders) {
      const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
      order.items = items;
    }

    res.json(orders);
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single order
router.get('/:id', authenticate, async (req, res) => {
  try {
    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (orders.length === 0) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [orders[0].id]);
    orders[0].items = items;
    res.json(orders[0]);
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/admin');

const router = express.Router();

router.use(authenticate, isAdmin);

// Dashboard stats
router.get('/dashboard', async (req, res) => {
  try {
    const [totalProducts] = await pool.query('SELECT COUNT(*) as count FROM products');
    const [totalOrders] = await pool.query('SELECT COUNT(*) as count FROM orders');
    const [totalUsers] = await pool.query('SELECT COUNT(*) as count FROM users WHERE role = ?', ['user']);
    const [totalRevenue] = await pool.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = ?', ['paid']);
    const [recentOrders] = await pool.query(
      'SELECT o.*, u.name as user_name FROM orders o LEFT JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC LIMIT 10'
    );
    const [pendingOrders] = await pool.query('SELECT COUNT(*) as count FROM orders WHERE status = ?', ['pending']);
    const [todayOrders] = await pool.query('SELECT COUNT(*) as count FROM orders WHERE DATE(created_at) = CURDATE()');
    const [todayRevenue] = await pool.query('SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE payment_status = ? AND DATE(paid_at) = CURDATE()', ['paid']);

    res.json({
      stats: {
        totalProducts: totalProducts[0].count,
        totalOrders: totalOrders[0].count,
        totalUsers: totalUsers[0].count,
        totalRevenue: totalRevenue[0].total,
        pendingOrders: pendingOrders[0].count,
        todayOrders: todayOrders[0].count,
        todayRevenue: todayRevenue[0].total
      },
      recentOrders
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Monthly revenue stats (for chart)
router.get('/stats/monthly', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(paid_at, '%Y-%m') as month, COALESCE(SUM(total_amount), 0) as revenue
      FROM orders WHERE payment_status = 'paid' AND paid_at IS NOT NULL
      AND paid_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(paid_at, '%Y-%m')
      ORDER BY month ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Monthly stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Product stats by category
router.get('/stats/categories', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT c.id, c.name_fa, c.name_en, COUNT(p.id) as product_count
      FROM categories c LEFT JOIN products p ON c.id = p.category_id
      GROUP BY c.id ORDER BY product_count DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Category stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all orders (for admin)
router.get('/orders', async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;
    let where = '';
    const params = [];

    if (status) {
      where = 'WHERE o.status = ?';
      params.push(status);
    }

    const [countResult] = await pool.query(`SELECT COUNT(*) as total FROM orders o ${where}`, params);
    const total = countResult[0].total;

    const [orders] = await pool.query(
      `SELECT o.*, u.name as user_name, u.email as user_email, u.phone as user_phone
       FROM orders o
       LEFT JOIN users u ON o.user_id = u.id
       ${where}
       ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    for (const order of orders) {
      const [items] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
      order.items = items;
    }

    res.json({
      orders,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Get all orders error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update order status
router.put('/orders/:id', async (req, res) => {
  try {
    const { status, payment_status } = req.body;
    const updates = [];
    const params = [];

    if (status) { updates.push('status = ?'); params.push(status); }
    if (payment_status) { updates.push('payment_status = ?'); params.push(payment_status); }
    if (payment_status === 'paid') { updates.push('paid_at = NOW()'); }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    params.push(req.params.id);
    await pool.query(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ message: 'Order updated' });
  } catch (err) {
    console.error('Update order error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all users
router.get('/users', async (req, res) => {
  try {
    const [users] = await pool.query(
      'SELECT id, name, email, phone, address, role, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(users);
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete user
router.delete('/users/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = ? AND role = ?', [req.params.id, 'user']);
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update user role
router.put('/users/:id', async (req, res) => {
  try {
    const { role } = req.body;
    await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: 'User updated' });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all products (including inactive) for admin
router.get('/products', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    const [countResult] = await pool.query('SELECT COUNT(*) as total FROM products');
    const total = countResult[0].total;

    const [products] = await pool.query(
      `SELECT p.*, c.name_fa as category_name_fa, c.name_en as category_name_en
       FROM products p LEFT JOIN categories c ON p.category_id = c.id
       ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
      [parseInt(limit), parseInt(offset)]
    );

    res.json({ products, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    console.error('Get admin products error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single product by ID (admin)
router.get('/products/:id', async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, c.name_fa as category_name_fa, c.name_en as category_name_en
       FROM products p LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (products.length === 0) return res.status(404).json({ message: 'Product not found' });
    res.json(products[0]);
  } catch (err) {
    console.error('Get admin product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all categories (including inactive) for admin
router.get('/categories/all', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT * FROM categories ORDER BY sort_order ASC, name_fa ASC');
    res.json(categories);
  } catch (err) {
    console.error('Get all categories error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get settings
router.get('/settings', async (req, res) => {
  try {
    const [settings] = await pool.query('SELECT * FROM settings');
    const result = {};
    settings.forEach(s => { result[s.key] = s.value; });
    res.json(result);
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update settings
router.put('/settings', async (req, res) => {
  try {
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        [key, value, value]
      );
    }
    res.json({ message: 'Settings updated' });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

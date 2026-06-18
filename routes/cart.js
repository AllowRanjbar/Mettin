const express = require('express');
const pool = require('../config/db');
const { authenticate, optionalAuth } = require('../middleware/auth');

const router = express.Router();

// Get cart items
router.get('/', optionalAuth, async (req, res) => {
  try {
    let items;
    if (req.user) {
      [items] = await pool.query(
        `SELECT ci.*, p.name_fa, p.name_en, p.price, p.sale_price, p.images, p.stock, p.slug
         FROM cart_items ci
         JOIN products p ON ci.product_id = p.id
         WHERE ci.user_id = ?
         ORDER BY ci.created_at DESC`,
        [req.user.id]
      );
    } else {
      const sessionId = req.query.session_id;
      if (!sessionId) return res.json({ items: [], total: 0 });
      [items] = await pool.query(
        `SELECT ci.*, p.name_fa, p.name_en, p.price, p.sale_price, p.images, p.stock, p.slug
         FROM cart_items ci
         JOIN products p ON ci.product_id = p.id
         WHERE ci.session_id = ?
         ORDER BY ci.created_at DESC`,
        [sessionId]
      );
    }

    const total = items.reduce((sum, item) => {
      const price = item.sale_price || item.price;
      return sum + price * item.quantity;
    }, 0);

    res.json({ items, total });
  } catch (err) {
    console.error('Get cart error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Add to cart
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { product_id, quantity = 1, session_id } = req.body;

    const [products] = await pool.query('SELECT id, stock FROM products WHERE id = ? AND is_active = 1', [product_id]);
    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    const userId = req.user ? req.user.id : null;
    const sessId = userId ? null : session_id;

    if (!userId && !sessId) {
      return res.status(400).json({ message: 'Login required or provide session_id' });
    }

    // Check existing
    let [existing] = userId
      ? await pool.query('SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?', [userId, product_id])
      : await pool.query('SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?', [sessId, product_id]);

    if (existing.length > 0) {
      const newQty = existing[0].quantity + parseInt(quantity);
      const userCondition = userId ? 'user_id = ?' : 'session_id = ?';
      const userVal = userId || sessId;
      await pool.query(
        `UPDATE cart_items SET quantity = ? WHERE ${userCondition} AND product_id = ?`,
        [newQty, userVal, product_id]
      );
    } else {
      await pool.query(
        'INSERT INTO cart_items (user_id, session_id, product_id, quantity) VALUES (?, ?, ?, ?)',
        [userId, sessId, product_id, quantity]
      );
    }

    res.json({ message: 'Added to cart' });
  } catch (err) {
    console.error('Add to cart error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update cart item quantity
router.put('/:id', optionalAuth, async (req, res) => {
  try {
    const { quantity } = req.body;
    if (quantity < 1) {
      return res.status(400).json({ message: 'Quantity must be at least 1' });
    }

    let query, params;
    if (req.user) {
      query = 'UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?';
      params = [quantity, req.params.id, req.user.id];
    } else {
      query = 'UPDATE cart_items SET quantity = ? WHERE id = ? AND session_id = ?';
      params = [quantity, req.params.id, req.query.session_id];
    }

    await pool.query(query, params);
    res.json({ message: 'Cart updated' });
  } catch (err) {
    console.error('Update cart error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Remove from cart
router.delete('/:id', optionalAuth, async (req, res) => {
  try {
    let query, params;
    if (req.user) {
      query = 'DELETE FROM cart_items WHERE id = ? AND user_id = ?';
      params = [req.params.id, req.user.id];
    } else {
      query = 'DELETE FROM cart_items WHERE id = ? AND session_id = ?';
      params = [req.params.id, req.query.session_id];
    }

    await pool.query(query, params);
    res.json({ message: 'Item removed from cart' });
  } catch (err) {
    console.error('Remove from cart error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Clear cart
router.delete('/', optionalAuth, async (req, res) => {
  try {
    if (req.user) {
      await pool.query('DELETE FROM cart_items WHERE user_id = ?', [req.user.id]);
    } else {
      await pool.query('DELETE FROM cart_items WHERE session_id = ?', [req.query.session_id]);
    }
    res.json({ message: 'Cart cleared' });
  } catch (err) {
    console.error('Clear cart error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Merge guest cart to user cart after login
router.post('/merge', authenticate, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ message: 'Session ID required' });

    const [guestItems] = await pool.query('SELECT * FROM cart_items WHERE session_id = ?', [session_id]);

    for (const item of guestItems) {
      const [existing] = await pool.query(
        'SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?',
        [req.user.id, item.product_id]
      );
      if (existing.length > 0) {
        await pool.query(
          'UPDATE cart_items SET quantity = quantity + ? WHERE id = ?',
          [item.quantity, existing[0].id]
        );
      } else {
        await pool.query(
          'INSERT INTO cart_items (user_id, product_id, quantity) VALUES (?, ?, ?)',
          [req.user.id, item.product_id, item.quantity]
        );
      }
    }

    await pool.query('DELETE FROM cart_items WHERE session_id = ?', [session_id]);
    res.json({ message: 'Cart merged successfully' });
  } catch (err) {
    console.error('Merge cart error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

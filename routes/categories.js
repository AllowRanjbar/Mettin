const express = require('express');
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { isAdmin } = require('../middleware/admin');

const router = express.Router();

// Get all active categories
router.get('/', async (req, res) => {
  try {
    const [categories] = await pool.query(
      'SELECT * FROM categories WHERE is_active = 1 ORDER BY sort_order ASC, name_fa ASC'
    );
    res.json(categories);
  } catch (err) {
    console.error('Get categories error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single category
router.get('/:id', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (categories.length === 0) {
      return res.status(404).json({ message: 'Category not found' });
    }
    res.json(categories[0]);
  } catch (err) {
    console.error('Get category error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create category
router.post('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { name_fa, name_en, slug, description_fa, description_en, image, sort_order } = req.body;
    const [result] = await pool.query(
      'INSERT INTO categories (name_fa, name_en, slug, description_fa, description_en, image, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [name_fa, name_en, slug, description_fa, description_en, image, sort_order || 0]
    );
    res.status(201).json({ id: result.insertId, message: 'Category created' });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update category
router.put('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const { name_fa, name_en, slug, description_fa, description_en, image, sort_order, is_active } = req.body;
    await pool.query(
      'UPDATE categories SET name_fa=?, name_en=?, slug=?, description_fa=?, description_en=?, image=?, sort_order=?, is_active=? WHERE id=?',
      [name_fa, name_en, slug, description_fa, description_en, image, sort_order, is_active, req.params.id]
    );
    res.json({ message: 'Category updated' });
  } catch (err) {
    console.error('Update category error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete category
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM categories WHERE id = ?', [req.params.id]);
    res.json({ message: 'Category deleted' });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

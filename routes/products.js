const express = require('express');
const pool = require('../config/db');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { isAdmin } = require('../middleware/admin');
const upload = require('../middleware/upload');

const router = express.Router();

// Get all products with filters
router.get('/', async (req, res) => {
  try {
    const { category, min_price, max_price, search, sort, page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;
    let where = 'WHERE p.is_active = 1';
    const params = [];

    if (category) {
      where += ' AND p.category_id = ?';
      params.push(category);
    }
    if (min_price) {
      where += ' AND COALESCE(p.sale_price, p.price) >= ?';
      params.push(parseInt(min_price));
    }
    if (max_price) {
      where += ' AND COALESCE(p.sale_price, p.price) <= ?';
      params.push(parseInt(max_price));
    }
    if (search) {
      where += ' AND (p.name_fa LIKE ? OR p.name_en LIKE ? OR p.description_fa LIKE ? OR p.description_en LIKE ?)';
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    let orderBy = 'ORDER BY p.created_at DESC';
    if (sort === 'price_asc') orderBy = 'ORDER BY COALESCE(p.sale_price, p.price) ASC';
    if (sort === 'price_desc') orderBy = 'ORDER BY COALESCE(p.sale_price, p.price) DESC';
    if (sort === 'newest') orderBy = 'ORDER BY p.created_at DESC';
    if (sort === 'name_fa') orderBy = 'ORDER BY p.name_fa ASC';
    if (sort === 'name_en') orderBy = 'ORDER BY p.name_en ASC';

    const countQuery = `SELECT COUNT(*) as total FROM products p ${where}`;
    const [countResult] = await pool.query(countQuery, params);
    const total = countResult[0].total;

    const query = `
      SELECT p.*, c.name_fa as category_name_fa, c.name_en as category_name_en, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${where}
      ${orderBy}
      LIMIT ? OFFSET ?
    `;

    const [products] = await pool.query(query, [...params, parseInt(limit), parseInt(offset)]);

    res.json({
      products,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get products error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get featured products
router.get('/featured', async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, c.name_fa as category_name_fa, c.name_en as category_name_en
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.is_active = 1 AND p.is_featured = 1
       ORDER BY p.created_at DESC LIMIT 8`
    );
    res.json(products);
  } catch (err) {
    console.error('Get featured error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single product by slug
router.get('/slug/:slug', async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, c.name_fa as category_name_fa, c.name_en as category_name_en, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.slug = ?`,
      [req.params.slug]
    );
    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json(products[0]);
  } catch (err) {
    console.error('Get product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get single product by ID
router.get('/:id', async (req, res) => {
  try {
    const [products] = await pool.query(
      `SELECT p.*, c.name_fa as category_name_fa, c.name_en as category_name_en, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ?`,
      [req.params.id]
    );
    if (products.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json(products[0]);
  } catch (err) {
    console.error('Get product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Create product
router.post('/', authenticate, isAdmin, upload.array('images', 10), async (req, res) => {
  try {
    const {
      name_fa, name_en, slug, description_fa, description_en,
      short_description_fa, short_description_en, price, sale_price,
      stock, sku, brand, capacity, stages, warranty, category_id, is_featured
    } = req.body;

    let images = [];
    if (req.files && req.files.length > 0) {
      images = req.files.map(f => `/uploads/${f.filename}`);
    }

    const [result] = await pool.query(
      `INSERT INTO products (category_id, name_fa, name_en, slug, description_fa, description_en,
        short_description_fa, short_description_en, price, sale_price, stock, sku, brand,
        capacity, stages, warranty, images, is_featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [category_id, name_fa, name_en, slug, description_fa, description_en,
        short_description_fa, short_description_en, price, sale_price || null, stock || 0,
        sku, brand, capacity, stages, warranty, JSON.stringify(images), is_featured || 0]
    );

    res.status(201).json({ id: result.insertId, message: 'Product created' });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Update product
router.put('/:id', authenticate, isAdmin, upload.array('images', 10), async (req, res) => {
  try {
    const fields = [];
    const params = [];

    const editable = ['name_fa', 'name_en', 'slug', 'description_fa', 'description_en',
      'short_description_fa', 'short_description_en', 'price', 'sale_price', 'stock',
      'sku', 'brand', 'capacity', 'stages', 'warranty', 'category_id', 'is_featured', 'is_active'];

    editable.forEach(field => {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    });

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map(f => `/uploads/${f.filename}`);
      const [existing] = await pool.query('SELECT images FROM products WHERE id = ?', [req.params.id]);
      let existingImages = [];
      try { existingImages = JSON.parse(existing[0].images || '[]'); } catch (e) { existingImages = []; }
      fields.push('images = ?');
      params.push(JSON.stringify([...existingImages, ...newImages]));
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    params.push(req.params.id);
    await pool.query(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`, params);
    res.json({ message: 'Product updated' });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: Delete product
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;

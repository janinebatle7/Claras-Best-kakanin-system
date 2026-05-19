const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Middleware to check if user is an Admin
const isAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'Admin') {
        next();
    } else {
        res.status(403).json({ error: "Access denied. Admins only." });
    }
};

// FETCH ALL PRODUCTS (Public Access - No Login Required)
router.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY name ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to retrieve products." });
    }
});

// FETCH A SINGLE PRODUCT BY ID (Public Access)
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Product not found." });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error retrieving product." });
    }
});

// ADD NEW PRODUCT (Admin Only)
router.post('/', isAdmin, async (req, res) => {
    const { name, description, price, stock_quantity, image_url } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO products (name, description, price, stock_quantity, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, description, price, stock_quantity, image_url || null]
        );
        res.status(201).json({ message: "Product added successfully!", product: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to create product." });
    }
});

// UPDATE PRODUCT & INVENTORY QUANTITY (Admin Only)
router.put('/:id', isAdmin, async (req, res) => {
    const { name, description, price, stock_quantity, image_url } = req.body;
    try {
        const result = await pool.query(
            `UPDATE products 
             SET name = COALESCE($1, name), 
                 description = COALESCE($2, description), 
                 price = COALESCE($3, price), 
                 stock_quantity = COALESCE($4, stock_quantity), 
                 image_url = COALESCE($5, image_url) 
             WHERE id = $6 RETURNING *`,
            [name, description, price, stock_quantity, image_url, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Product not found." });
        }
        res.json({ message: "Product updated successfully!", product: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to update product." });
    }
});

// DELETE PRODUCT (Admin Only)
router.delete('/:id', isAdmin, async (req, res) => {
    try {
        const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING *', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Product not found." });
        }
        res.json({ message: "Product deleted from system successfully." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to delete product." });
    }
});

module.exports = router;
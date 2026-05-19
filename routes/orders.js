const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// Middleware to check if user is logged in
const isUser = (req, res, next) => {
    if (req.session.user) next();
    else res.status(401).json({ error: "Authentication required. Please sign in." });
};

// Middleware to check if user is Staff or Admin
const isStaffOrAdmin = (req, res, next) => {
    if (req.session.user && (req.session.user.role === 'Staff' || req.session.user.role === 'Admin')) {
        next();
    } else {
        res.status(403).json({ error: "Access denied. Management staff privileges required." });
    }
};

// 1. PLACE AN ORDER OR ADVANCE RESERVATION (Logged-In Customers)
router.post('/', isUser, async (req, res) => {
    const { items, type, payment_method, pickup_date_time } = req.body;
    const userId = req.session.user.id;
    const customerName = req.session.user.name;

    if (!items || items.length === 0 || !type || !payment_method) {
        return res.status(400).json({ error: "Missing required order information." });
    }

    try {
        // Start database transaction block
        await pool.query('BEGIN');
        
        let totalCalculatedPrice = 0;

        // Verify stock availability and calculate prices
        for (let item of items) {
            const prodRes = await pool.query('SELECT price, stock_quantity, name FROM products WHERE id = $1', [item.product_id]);
            if (prodRes.rows.length === 0) {
                throw new Error(`Product ID ${item.product_id} no longer exists.`);
            }
            const product = prodRes.rows[0];
            
            if (product.stock_quantity < item.quantity) {
                throw new Error(`Insufficient inventory stock for ${product.name}.`);
            }
            totalCalculatedPrice += parseFloat(product.price) * item.quantity;
        }

        // Insert primary record into orders table
        const orderRes = await pool.query(
            `INSERT INTO orders (user_id, customer_name, type, total_price, payment_method, pickup_date_time) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [userId, customerName, type, totalCalculatedPrice, payment_method, pickup_date_time || null]
        );
        const orderId = orderRes.rows[0].id;

        // Save broken-down item lines and update inventory stocks
        for (let item of items) {
            const prodRes = await pool.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
            const priceAtPurchase = prodRes.rows[0].price;

            await pool.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, $3, $4)`,
                [orderId, item.product_id, item.quantity, priceAtPurchase]
            );

            await pool.query(
                'UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2',
                [item.quantity, item.product_id]
            );
        }

        await pool.query('COMMIT');
        res.status(201).json({ message: "Transaction completed successfully!", orderId });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    }
});

// 2. LOG A OVER-THE-COUNTER WALK-IN ORDER (Staff / Admin Only)
router.post('/walk-in', isStaffOrAdmin, async (req, res) => {
    const { items, customer_name, payment_method } = req.body;

    try {
        await pool.query('BEGIN');
        let totalCalculatedPrice = 0;

        for (let item of items) {
            const prodRes = await pool.query('SELECT price, stock_quantity FROM products WHERE id = $1', [item.product_id]);
            if (prodRes.rows[0].stock_quantity < item.quantity) throw new Error("Out of stock items present.");
            totalCalculatedPrice += parseFloat(prodRes.rows[0].price) * item.quantity;
        }

        // Walk-ins leave user_id empty (null), default statuses to paid/completed
        const orderRes = await pool.query(
            `INSERT INTO orders (user_id, customer_name, type, total_price, payment_method, payment_status, order_status) 
             VALUES (NULL, $1, 'Walk-in', $2, $3, 'Paid', 'Completed') RETURNING id`,
            [customer_name || 'Walk-in Customer', totalCalculatedPrice, payment_method]
        );
        const orderId = orderRes.rows[0].id;

        for (let item of items) {
            const priceRes = await pool.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
            await pool.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, $3, $4)`,
                [orderId, item.product_id, item.quantity, priceRes.rows[0].price]
            );
            await pool.query('UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2', [item.quantity, item.product_id]);
        }

        await pool.query('COMMIT');
        res.status(201).json({ message: "Walk-in sale saved to record database." });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    }
});

// 3. FETCH TRANSACTION HISTORY FOR THE LOGGED-IN CUSTOMER
router.get('/my-orders', isUser, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [req.session.user.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch your transactions history." });
    }
});

// 4. FETCH ALL SYSTEM TRANSACTIONS (Staff & Admin Dashboard View)
router.get('/all', isStaffOrAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to pull system queue data." });
    }
});

// 5. REMIT PAYMENT & ORDER QUEUE UPDATES (Staff / Admin Only)
router.put('/:id', isStaffOrAdmin, async (req, res) => {
    const { order_status, payment_status } = req.body;
    try {
        const result = await pool.query(
            `UPDATE orders 
             SET order_status = COALESCE($1, order_status), 
                 payment_status = COALESCE($2, payment_status) 
             WHERE id = $3 RETURNING *`,
            [order_status, payment_status, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: "Order record not found." });
        res.json({ message: "Order record successfully updated.", order: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: "Failed to update record state details." });
    }
});

module.exports = router;
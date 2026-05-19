const express = require('express');
const mysql = require('mysql2/promise');
const session = require('express-session');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();

// Database configuration
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql-38880adb-janine-batle10.e.aivencloud.com',
    user: process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASSWORD || 'AVNS_G2z57INXzp0GM7bXKVK', 
    database: process.env.DB_NAME || 'kakanin_Final',
    port: parseInt(process.env.DB_PORT) || 12590,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'claras_best_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('pool', pool);

// --- AUTH ROUTES ---
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)', 
        [name, email, hashedPassword, phone, 'Customer']);
        res.status(201).json({ message: "Registration successful!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(400).json({ error: "User not found" });

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Incorrect password" });

        req.session.user = { id: user.id, name: user.name, role: user.role };
        res.json({ message: "Login successful", role: user.role });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: "Logged out" });
});

// --- PRODUCTS ROUTE ---
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ORDERS & RESERVATIONS ---
app.post('/api/orders', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Please log in first." });
    
    const { items, type, payment_method, pickup_date_time, customer_name } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.query('START TRANSACTION');
        let total = 0;
        for (let item of items) {
            const [prodRows] = await connection.query('SELECT price FROM products WHERE id = ?', [item.product_id]);
            total += prodRows[0].price * item.quantity;
        }

        const [orderRes] = await connection.query(
            `INSERT INTO orders (user_id, customer_name, type, total_price, payment_method, pickup_date_time) VALUES (?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, customer_name || req.session.user.name, type, total, payment_method, pickup_date_time]
        );
        const orderId = orderRes.insertId;

        for (let item of items) {
            const [prodRows] = await connection.query('SELECT price FROM products WHERE id = ?', [item.product_id]);
            await connection.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)`,
                [orderId, item.product_id, item.quantity, prodRows[0].price]
            );
            await connection.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, item.product_id]);
        }

        await connection.query('COMMIT');
        res.status(201).json({ message: "Order processed!", orderId });
    } catch (err) {
        await connection.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally { connection.release(); }
});

app.get('/api/orders', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    try {
        const [rows] = await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC', [req.session.user.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CANCELLATIONS & PAYMENTS ---
app.post('/api/orders/:id/cancel', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    try {
        await pool.query("UPDATE orders SET cancellation_status = 'Pending', cancellation_reason = ? WHERE id = ? AND user_id = ?", 
        [req.body.reason, req.params.id, req.session.user.id]);
        res.json({ message: "Cancellation request filed." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/:id/payment', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    try {
        const [order] = await pool.query('SELECT total_price FROM orders WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
        if(order.length === 0) return res.status(404).json({ error: "Order not found" });
        
        await pool.query('INSERT INTO payments (order_id, amount_paid, payment_method, reference_number, paid_at) VALUES (?, ?, ?, ?, NOW())', 
        [req.params.id, order[0].total_price, 'GCash', req.body.reference_number]);
        res.json({ message: "Payment recorded." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/payments/history', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    try {
        const [rows] = await pool.query('SELECT * FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)', [req.session.user.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PROFILE ---
app.get('/api/profile', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    const [rows] = await pool.query('SELECT name, email, phone FROM users WHERE id = ?', [req.session.user.id]);
    res.json(rows[0]);
});

app.put('/api/profile/update', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    await pool.query('UPDATE users SET name = ?, phone = ? WHERE id = ?', [req.body.name, req.body.phone, req.session.user.id]);
    req.session.user.name = req.body.name;
    res.json({ message: "Profile updated." });
});

// --- ADMIN ---
app.put('/api/orders/:id', async (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'Admin' && req.session.user.role !== 'Staff')) 
        return res.status(403).json({ error: "Access denied" });
        
    await pool.query('UPDATE orders SET order_status = COALESCE(?, order_status), payment_status = COALESCE(?, payment_status) WHERE id = ?', 
    [req.body.order_status, req.body.payment_status, req.params.id]);
    res.json({ message: "Order updated." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
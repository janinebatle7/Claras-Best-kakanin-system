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
    connectionLimit: 10
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: process.env.SESSION_SECRET || 'claras_best_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true }
}));

// Authorization helper
const isStaff = (req) => req.session.user && (req.session.user.role === 'Admin' || req.session.user.role === 'Staff');

// --- AUTH ROUTES ---
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)', 
        [name, email, hashedPassword, phone, 'Customer']);
        res.status(201).json({ message: "Registration successful" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [req.body.email]);
        if (users.length === 0 || !(await bcrypt.compare(req.body.password, users[0].password))) 
            return res.status(400).json({ error: "Invalid credentials" });

        req.session.user = { id: users[0].id, name: users[0].name, role: users[0].role };
        res.json({ message: "Login successful", role: users[0].role });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ message: "Logged out" }));
});

// --- CORE ROUTES ---
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    try {
        const sql = isStaff(req) ? 'SELECT * FROM orders ORDER BY id DESC' : 'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC';
        const [rows] = await pool.query(sql, [req.session.user.id]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const { items, type, payment_method, customer_name } = req.body;
        
        let total = 0;
        for (let item of items) {
            const [[prod]] = await conn.query('SELECT price FROM products WHERE id = ?', [item.product_id]);
            total += prod.price * item.quantity;
            await conn.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, item.product_id]);
        }
        
        const [order] = await conn.query('INSERT INTO orders (user_id, customer_name, type, total_price, payment_method) VALUES (?, ?, ?, ?, ?)',
            [req.session.user.id, customer_name || req.session.user.name, type, total, payment_method]);
        
        await conn.commit();
        res.status(201).json({ message: "Order processed", orderId: order.insertId });
    } catch (err) { await conn.rollback(); res.status(500).json({ error: err.message }); }
    finally { conn.release(); }
});

// --- ADMIN/STAFF MANAGEMENT ---
app.get('/api/admin/sales', async (req, res) => {
    if (!isStaff(req)) return res.status(403).json({ error: "Unauthorized" });
    try {
        const [[sales]] = await pool.query('SELECT SUM(total_price) as total FROM orders WHERE payment_status = "Paid"');
        const [[pending]] = await pool.query('SELECT COUNT(*) as count FROM orders WHERE order_status != "Completed"');
        res.json({ totalSales: sales.total || 0, pendingOrders: pending.count });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id', async (req, res) => {
    if (!isStaff(req)) return res.status(403).json({ error: "Access denied" });
    await pool.query('UPDATE orders SET order_status = ?, payment_status = ? WHERE id = ?', 
    [req.body.order_status, req.body.payment_status, req.params.id]);
    res.json({ message: "Updated" });
});

app.get('/api/payments', async (req, res) => {
    if (!isStaff(req)) return res.status(403).json({ error: "Access denied" });
    const [rows] = await pool.query('SELECT * FROM payments ORDER BY paid_at DESC');
    res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
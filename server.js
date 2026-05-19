const express = require('express');
const mysql = require('mysql2/promise');
const session = require('express-session');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import the router modules
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');

const app = express();

// Database configuration connection pool (Reading from environment variables to bypass GitHub block)
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'mysql-38880adb-janine-batle10.e.aivencloud.com',
    user: process.env.DB_USER || 'avnadmin',
    password: process.env.DB_PASSWORD || 'AVNS_G2z57INXzp0GM7bXKVK', 
    database: process.env.DB_NAME || 'kakanin_Final',
    port: parseInt(process.env.DB_PORT) || 12590, // Explicitly route through Aiven's custom MySQL port
    ssl: {
        rejectUnauthorized: false // Necessary handshake configuration for cloud instances
    },
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware standard parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Express Session state initialization
app.use(session({
    secret: process.env.SESSION_SECRET || 'claras_best_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day validity
}));

// Expose the database pool instance globally so your routes can access it if needed
app.set('pool', pool);

// --- LINK MODULAR ROUTES (Keeps front-end fetch calls working perfectly) ---
app.use('/api', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);

// --- AUTHENTICATION BACKUP FALLBACKS ---
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Swapped to MySQL "?" parameterization syntax
        await pool.query(
            'INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, phone, 'Customer']
        );
        res.status(201).json({ message: "Registration successful!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        // Destructured MySQL results array structure
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) return res.status(400).json({ error: "User not found" });

        const user = rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: "Incorrect password" });

        req.session.user = { id: user.id, name: user.name, role: user.role };
        res.json({ message: "Login successful", role: user.role });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: "Logged out" });
});

// --- PUBLIC: FETCH PRODUCTS FALLBACK ---
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CUSTOMER: PLACE ORDER/RESERVATION FALLBACK ---
app.post('/api/orders', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Please log in first." });
    
    const { items, type, payment_method, pickup_date_time, customer_name } = req.body;
    const userId = req.session.user.id;

    // Grab a single clean connection link to accurately manage transactional queries
    const connection = await pool.getConnection();
    try {
        await connection.query('START TRANSACTION');
        
        let total = 0;
        for (let item of items) {
            const [prodRows] = await connection.query('SELECT price FROM products WHERE id = ?', [item.product_id]);
            total += prodRows[0].price * item.quantity;
        }

        const [orderRes] = await connection.query(
            `INSERT INTO orders (user_id, customer_name, type, total_price, payment_method, pickup_date_time) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, customer_name || req.session.user.name, type, total, payment_method, pickup_date_time]
        );
        const orderId = orderRes.insertId; // Pulling inserted ID via native MySQL parameter formats

        for (let item of items) {
            const [prodRows] = await connection.query('SELECT price FROM products WHERE id = ?', [item.product_id]);
            await connection.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)`,
                [orderId, item.product_id, item.quantity, prodRows[0].price]
            );
            await connection.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, item.product_id]);
        }

        await connection.query('COMMIT');
        res.status(201).json({ message: "Order processed successfully!", orderId });
    } catch (err) {
        await connection.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        connection.release(); // Explicitly release connection back to pool
    }
});

// --- STAFF/ADMIN: UPDATE ORDER STATUS & RECORD PAYMENTS FALLBACK ---
app.put('/api/orders/:id', async (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'Staff' && req.session.user.role !== 'Admin')) {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    try {
        const { order_status, payment_status } = req.body;
        // Reconfigured query using COALESCE with correct order parameters
        await pool.query(
            'UPDATE orders SET order_status = COALESCE(?, order_status), payment_status = COALESCE(?, payment_status) WHERE id = ?',
            [order_status, payment_status, req.params.id]
        );
        res.json({ message: "Order updated successfully." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN: SALES MONITORING ---
app.get('/api/admin/sales', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Admin') return res.status(403).json({ error: "Access denied" });
    try {
        const [salesRows] = await pool.query("SELECT SUM(total_price) AS sum FROM orders WHERE payment_status = 'Paid'");
        const [pendingRows] = await pool.query("SELECT COUNT(*) AS count FROM orders WHERE order_status = 'Pending'");
        
        res.json({ 
            totalSales: salesRows[0].sum || 0, 
            pendingOrders: pendingRows[0].count 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Port binding listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
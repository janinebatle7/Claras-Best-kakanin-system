const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Import the router modules
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');

const app = express();

// Database configuration connection pool (using your Aiven string)
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

// Middleware standard parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Express Session state initialization
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day validity
}));

// Expose the database pool instance globally so your routes can access it if needed
app.set('pool', pool);


// --- LINK MODULAR ROUTES (Keeps front-end fetch calls working perfectly) ---
// Mounts everything seamlessly to your front-end scripts (/api/login, /api/products, etc.)
app.use('/api', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);


// --- AUTHENTICATION BACKUP FALLBACKS ---
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password, phone } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (name, email, password, phone, role) VALUES ($1, $2, $3, $4, $5)',
            [name, email, hashedPassword, phone, 'Customer']
        );
        res.status(201).json({ message: "Registration successful!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: "User not found" });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Incorrect password" });

    req.session.user = { id: user.id, name: user.name, role: user.role };
    res.json({ message: "Login successful", role: user.role });
});

app.get('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ message: "Logged out" });
});

// --- PUBLIC: FETCH PRODUCTS FALLBACK ---
app.get('/api/products', async (req, res) => {
    const result = await pool.query('SELECT * FROM products');
    res.json(result.rows);
});

// --- CUSTOMER: PLACE ORDER/RESERVATION FALLBACK ---
app.post('/api/orders', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: "Please log in first." });
    
    const { items, type, payment_method, pickup_date_time, customer_name } = req.body;
    const userId = req.session.user.id;

    try {
        await pool.query('BEGIN');
        
        let total = 0;
        for (let item of items) {
            const prod = await pool.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
            total += prod.rows[0].price * item.quantity;
        }

        const orderRes = await pool.query(
            `INSERT INTO orders (user_id, customer_name, type, total_price, payment_method, pickup_date_time) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [userId, customer_name || req.session.user.name, type, total, payment_method, pickup_date_time]
        );
        const orderId = orderRes.rows[0].id;

        for (let item of items) {
            const prod = await pool.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
            await pool.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES ($1, $2, $3, $4)`,
                [orderId, item.product_id, item.quantity, prod.rows[0].price]
            );
            await pool.query('UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2', [item.quantity, item.product_id]);
        }

        await pool.query('COMMIT');
        res.status(201).json({ message: "Order processed successfully!", orderId });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

// --- STAFF/ADMIN: UPDATE ORDER STATUS & RECORD PAYMENTS FALLBACK ---
app.put('/api/orders/:id', async (req, res) => {
    if (!req.session.user || (req.session.user.role !== 'Staff' && req.session.user.role !== 'Admin')) {
        return res.status(403).json({ error: "Unauthorized access" });
    }
    const { order_status, payment_status } = req.body;
    await pool.query(
        'UPDATE orders SET order_status = COALESCE($1, order_status), payment_status = COALESCE($2, payment_status) WHERE id = $3',
        [order_status, payment_status, req.params.id]
    );
    res.json({ message: "Order updated successfully." });
});

// --- ADMIN: SALES MONITORING ---
app.get('/api/admin/sales', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'Admin') return res.status(403).json({ error: "Access denied" });
    const totalSales = await pool.query("SELECT SUM(total_price) FROM orders WHERE payment_status = 'Paid'");
    const pendingOrders = await pool.query("SELECT COUNT(*) FROM orders WHERE order_status = 'Pending'");
    res.json({ totalSales: totalSales.rows[0].sum || 0, pendingOrders: pendingOrders.rows[0].count });
});

// Port binding listener
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
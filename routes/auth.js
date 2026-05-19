const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

// CUSTOMER SIGNUP
router.post('/signup', async (req, res) => {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password || !phone) {
        return res.status(400).json({ error: "All fields are required." });
    }

    try {
        // Check if user already exists
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.status(400).json({ error: "Email is already registered." });
        }

        // Hash the password for security
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Insert new customer into the database
        await pool.query(
            'INSERT INTO users (name, email, password, phone, role) VALUES ($1, $2, $3, $4, $5)',
            [name, email, hashedPassword, phone, 'Customer']
        );

        res.status(201).json({ message: "Registration successful! You can now log in." });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error during registration." });
    }
});

// USER LOGIN (Customer, Staff, Admin)
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Please enter all fields." });
    }

    try {
        // Find user by email
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Invalid email or password." });
        }

        const user = result.rows[0];

        // Check password validation
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: "Invalid email or password." });
        }

        // Save essential user data into the session
        req.session.user = {
            id: user.id,
            name: user.name,
            role: user.role
        };

        res.json({ 
            message: "Login successful!", 
            role: user.role,
            user: { name: user.name, email: user.email }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error during login." });
    }
});

// USER LOGOUT
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: "Could not log out. Try again." });
        }
        res.clearCookie('connect.sid'); // Clear session cookie
        res.json({ message: "Successfully logged out." });
    });
});

// CHECK CURRENT SESSION STATUS
router.get('/session', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false });
    }
});

module.exports = router;
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// --- USER SIGNUP ROUTE ---
router.post('/signup', async (req, res) => {
    // This grabs the clean MySQL connection pool we defined in server.js
    const pool = req.app.get('pool'); 
    
    try {
        const { name, email, password, phone } = req.body;
        
        // 1. Check if the user email already exists using MySQL syntax
        const [existingUser] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ error: "Email address is already registered." });
        }

        // 2. Hash the password for secure database storage
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // 3. Insert the new user into your MySQL database table
        await pool.query(
            'INSERT INTO users (name, email, password, phone, role) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, phone, 'Customer']
        );
        
        res.status(201).json({ message: "Registration successful!" });
    } catch (err) {
        console.error("Signup Database Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// --- USER LOGIN ROUTE ---
router.post('/login', async (req, res) => {
    const pool = req.app.get('pool');
    
    try {
        const { email, password } = req.body;
        
        // Query the user using MySQL syntax
        const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (rows.length === 0) {
            return res.status(400).json({ error: "User not found" });
        }

        const user = rows[0];
        
        // Compare the submitted password with the hashed password in the database
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: "Incorrect password" });
        }

        // Initialize the user session structure
        req.session.user = { id: user.id, name: user.name, role: user.role };
        
        // Return success message and user role for front-end redirection routing
        res.json({ message: "Login successful", role: user.role });
    } catch (err) {
        console.error("Login Database Error:", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
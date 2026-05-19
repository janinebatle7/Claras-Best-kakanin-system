const { Pool } = require('pg');
require('dotenv').config();

// Initialize the database connection pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for secure Aiven cloud connections
    }
});

pool.on('connect', () => {
    console.log('Successfully connected to the Aiven PostgreSQL database.');
});

pool.on('error', (err) => {
    console.error('Unexpected error on idle database client:', err);
    process.exit(-1);
});

module.exports = pool;
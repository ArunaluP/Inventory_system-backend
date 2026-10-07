const mysql = require('mysql2/promise');
// Load the .env next to server.js regardless of the working directory (iisnode)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
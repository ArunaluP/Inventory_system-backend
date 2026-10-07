// Shared HTTP helpers: consistent JSON errors that don't leak database internals.
const { parseId: parseStrictId } = require('./parse');

const isProduction = process.env.NODE_ENV === 'production';
// Error details are only sent to the browser when explicitly running in development, so a
// server started without NODE_ENV never leaks database messages.
const showErrorDetails = process.env.NODE_ENV === 'development';

// 500 response: the real error is always logged on the server; it is only sent to the
// client when NODE_ENV=development.
const sendServerError = (res, message, error) => {
  console.error(`[${new Date().toISOString()}] ${message}:`, error);
  res.status(500).json({
    success: false,
    message,
    ...(showErrorDetails ? { error: error?.message } : {})
  });
};

// Route ids must be positive whole numbers ("12", not "1.5", "0x1F" or "1e3"); anything else
// is a 400, not a DB query.
const parseId = (value) => parseStrictId(value);

const sendInvalidId = (res) => res.status(400).json({ success: false, message: 'Invalid id.' });

module.exports = { isProduction, showErrorDetails, sendServerError, parseId, sendInvalidId };

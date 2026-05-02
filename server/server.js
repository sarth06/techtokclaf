'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { testConnection } = require('./config/database');
const itemRoutes = require('./routes/items');
const claimRoutes = require('./routes/claims');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// CORS — restrict to explicit origin in production; fall back to same-origin
// ---------------------------------------------------------------------------
const allowedOrigin = process.env.CLIENT_ORIGIN;
app.use(cors({
  origin: allowedOrigin || false,  // false = same-origin only when not configured
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ---------------------------------------------------------------------------
// Rate limiting — protect all API endpoints
// ---------------------------------------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'client')));
app.use('/firebase', express.static(path.join(__dirname, '..', 'firebase')));

// ---------------------------------------------------------------------------
// API Routes — apply rate limiting
// ---------------------------------------------------------------------------
// Auth-sensitive routes get stricter limiting
app.use('/items', authLimiter, itemRoutes);
app.use('/claims', authLimiter, claimRoutes);
app.use('/notifications', apiLimiter, notificationRoutes);
// Top-level match routes (GET /matches/:itemId, POST /matches/instant)
app.use('/matches', apiLimiter, require('./routes/matches'));

// ---------------------------------------------------------------------------
// Catch-all: serve SPA for HTML navigation routes (not API)
// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
  // Let API errors through rather than returning HTML
  if (req.path.startsWith('/items') || req.path.startsWith('/claims') ||
      req.path.startsWith('/notifications') || req.path.startsWith('/matches')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
testConnection().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 TechTokClaf server running on http://localhost:${PORT}`);
  });
});

module.exports = app;

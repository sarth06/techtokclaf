const admin = require('firebase-admin');
require('dotenv').config();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY
        ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        : undefined,
    }),
  });
}

const { pool } = require('../config/database');

/**
 * Middleware: Verify Firebase ID token and attach user record to req.user
 */
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const firebaseUid = decoded.uid;
    const email = decoded.email;

    // Upsert user into the database
    const [rows] = await pool.execute(
      `INSERT INTO users (firebase_uid, email, credits)
       VALUES (?, ?, 0)
       ON DUPLICATE KEY UPDATE email = VALUES(email)`,
      [firebaseUid, email]
    );

    // Fetch the user record
    const [users] = await pool.execute(
      'SELECT * FROM users WHERE firebase_uid = ?',
      [firebaseUid]
    );

    if (!users.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.user = users[0];
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { authenticate };

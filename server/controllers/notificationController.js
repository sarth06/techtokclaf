'use strict';
const { pool } = require('../config/database');

// GET /notifications
async function getNotifications(req, res) {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('getNotifications error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
}

// PUT /notifications/:id/read
async function markRead(req, res) {
  const { id } = req.params;
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM notifications WHERE id = ? AND user_id = ?',
      [id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notification not found' });

    await pool.execute(
      'UPDATE notifications SET read_at = NOW() WHERE id = ?',
      [id]
    );
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    console.error('markRead error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
}

// PUT /notifications/read-all
async function markAllRead(req, res) {
  const userId = req.user.id;
  try {
    await pool.execute(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [userId]
    );
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('markAllRead error:', err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
}

module.exports = { getNotifications, markRead, markAllRead };

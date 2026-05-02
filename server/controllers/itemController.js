'use strict';
const { pool } = require('../config/database');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple tokenizer: lowercase, split on non-alphanumeric, filter short tokens.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Compute Jaccard similarity between two token sets.
 * Returns a value 0–100.
 */
function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = new Set([...setA].filter((t) => setB.has(t)));
  const union = new Set([...setA, ...setB]);
  return Math.round((intersection.size / union.size) * 100);
}

/**
 * Keyword-based matching between two items.
 * Returns { similarity_score, matched_keywords }.
 */
function matchItems(itemA, itemB) {
  const fields = ['title', 'description', 'category', 'location'];
  let totalScore = 0;
  const matchedKeywords = new Set();

  for (const field of fields) {
    const tokA = tokenize(itemA[field]);
    const tokB = tokenize(itemB[field]);
    const score = jaccardSimilarity(tokA, tokB);
    totalScore += score;

    // Collect actual shared tokens
    const setA = new Set(tokA);
    tokB.forEach((t) => {
      if (setA.has(t)) matchedKeywords.add(t);
    });
  }

  const similarity_score = Math.round(totalScore / fields.length);
  return { similarity_score, matched_keywords: [...matchedKeywords] };
}

/**
 * Award credits to a user and update badges.
 */
async function awardCredits(userId, amount, conn) {
  const db = conn || pool;
  await db.execute(
    'UPDATE users SET credits = credits + ? WHERE id = ?',
    [amount, userId]
  );
  await refreshBadges(userId, db);
}

/**
 * Deduct credits. Returns false if insufficient.
 */
async function deductCredits(userId, amount, conn) {
  const db = conn || pool;
  const [rows] = await db.execute('SELECT credits FROM users WHERE id = ?', [userId]);
  if (!rows.length || rows[0].credits < amount) return false;
  await db.execute(
    'UPDATE users SET credits = credits - ? WHERE id = ?',
    [amount, userId]
  );
  return true;
}

/**
 * Refresh badges based on current credits.
 */
async function refreshBadges(userId, conn) {
  const db = conn || pool;
  const [rows] = await db.execute('SELECT credits FROM users WHERE id = ?', [userId]);
  if (!rows.length) return;
  const { credits } = rows[0];
  const badges = [];
  if (credits > 30) badges.push('Trusted User');
  await db.execute(
    'UPDATE users SET badges = ? WHERE id = ?',
    [JSON.stringify(badges), userId]
  );
}

/**
 * Create a notification record.
 */
async function createNotification(userId, type, message, itemId) {
  try {
    await pool.execute(
      'INSERT INTO notifications (user_id, type, message, item_id) VALUES (?, ?, ?, ?)',
      [userId, type, message, itemId || null]
    );
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}

/**
 * Validate required item fields.
 */
function validateItem(body) {
  const required = ['title', 'description', 'category', 'type', 'location', 'date'];
  for (const f of required) {
    if (!body[f] || String(body[f]).trim() === '') {
      return `Field "${f}" is required`;
    }
  }
  if (!['lost', 'found'].includes(body.type)) {
    return 'type must be "lost" or "found"';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

// GET /items
async function getItems(req, res) {
  try {
    const { type, status, category, search } = req.query;
    let sql = `
      SELECT i.*, u.email AS owner_email, u.credits AS owner_credits,
             u.badges AS owner_badges,
             (i.boost_until IS NOT NULL AND i.boost_until > NOW()) AS is_boosted
      FROM items i
      JOIN users u ON i.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (type) { sql += ' AND i.type = ?'; params.push(type); }
    if (status) { sql += ' AND i.status = ?'; params.push(status); }
    if (category) { sql += ' AND i.category = ?'; params.push(category); }
    if (search) {
      sql += ' AND (i.title LIKE ? OR i.description LIKE ? OR i.location LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    // Boosted items first, then recency
    sql += ' ORDER BY is_boosted DESC, i.created_at DESC';

    const [rows] = await pool.execute(sql, params);

    // Strip hidden fields unless the requester owns the item
    const userId = req.user.id;
    const sanitized = rows.map((item) => {
      if (item.user_id !== userId) {
        delete item.hidden_marks;
        delete item.hidden_contents;
        delete item.hidden_context;
      }
      return item;
    });

    res.json(sanitized);
  } catch (err) {
    console.error('getItems error:', err);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
}

// GET /items/:id
async function getItemById(req, res) {
  try {
    const [rows] = await pool.execute(
      `SELECT i.*, u.email AS owner_email, u.credits AS owner_credits,
              (i.boost_until IS NOT NULL AND i.boost_until > NOW()) AS is_boosted
       FROM items i JOIN users u ON i.user_id = u.id
       WHERE i.id = ?`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    if (item.user_id !== req.user.id) {
      delete item.hidden_marks;
      delete item.hidden_contents;
      delete item.hidden_context;
    }
    res.json(item);
  } catch (err) {
    console.error('getItemById error:', err);
    res.status(500).json({ error: 'Failed to fetch item' });
  }
}

// POST /items
async function createItem(req, res) {
  const validationError = validateItem(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const {
    title, description, category, type, location, date,
    image_url, hidden_marks, hidden_contents, hidden_context,
  } = req.body;

  const userId = req.user.id;

  try {
    const [result] = await pool.execute(
      `INSERT INTO items
         (title, description, category, type, location, date, image_url,
          hidden_marks, hidden_contents, hidden_context, user_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        title.trim(), description.trim(), category.trim(), type, location.trim(),
        date, image_url || null,
        hidden_marks || null, hidden_contents || null, hidden_context || null,
        userId,
      ]
    );

    // Credit reward
    const creditAmt = type === 'found' ? 5 : 2;
    await awardCredits(userId, creditAmt);

    // Notify smart alert subscribers whose items match this new item
    const [newItem] = await pool.execute('SELECT * FROM items WHERE id = ?', [result.insertId]);
    if (newItem.length) {
      await triggerSmartAlerts(newItem[0]);
    }

    const [created] = await pool.execute('SELECT * FROM items WHERE id = ?', [result.insertId]);
    res.status(201).json(created[0]);
  } catch (err) {
    console.error('createItem error:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
}

// PUT /items/:id
async function updateItem(req, res) {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    if (rows[0].user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const {
      title, description, category, type, location, date,
      image_url, status, hidden_marks, hidden_contents, hidden_context,
    } = req.body;

    await pool.execute(
      `UPDATE items SET
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         category = COALESCE(?, category),
         type = COALESCE(?, type),
         location = COALESCE(?, location),
         date = COALESCE(?, date),
         image_url = COALESCE(?, image_url),
         status = COALESCE(?, status),
         hidden_marks = COALESCE(?, hidden_marks),
         hidden_contents = COALESCE(?, hidden_contents),
         hidden_context = COALESCE(?, hidden_context)
       WHERE id = ?`,
      [
        title || null, description || null, category || null, type || null,
        location || null, date || null, image_url || null, status || null,
        hidden_marks || null, hidden_contents || null, hidden_context || null,
        id,
      ]
    );

    const [updated] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    res.json(updated[0]);
  } catch (err) {
    console.error('updateItem error:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
}

// DELETE /items/:id
async function deleteItem(req, res) {
  const { id } = req.params;
  const userId = req.user.id;

  try {
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    if (rows[0].user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    await pool.execute('DELETE FROM items WHERE id = ?', [id]);
    res.json({ message: 'Item deleted successfully' });
  } catch (err) {
    console.error('deleteItem error:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
}

// GET /matches/:itemId
async function getMatches(req, res) {
  const { itemId } = req.params;
  const userId = req.user.id;

  try {
    // Determine how many matches to show
    const userCredits = req.user.credits;
    const limit = userCredits > 20 ? 10 : 3;

    const [sourceRows] = await pool.execute('SELECT * FROM items WHERE id = ?', [itemId]);
    if (!sourceRows.length) return res.status(404).json({ error: 'Item not found' });

    const source = sourceRows[0];

    // Find opposite-type active items (not owned by this user)
    const oppositeType = source.type === 'lost' ? 'found' : 'lost';
    const [candidates] = await pool.execute(
      `SELECT * FROM items WHERE type = ? AND status = 'active' AND id != ?`,
      [oppositeType, itemId]
    );

    // Score each candidate
    const scored = candidates
      .map((item) => {
        const { similarity_score, matched_keywords } = matchItems(source, item);
        return { ...item, similarity_score, matched_keywords };
      })
      .filter((item) => item.similarity_score > 0)
      .sort((a, b) => {
        // Priority matching: boost high-credit users' items higher
        const aBoost = a.boost_until && new Date(a.boost_until) > new Date() ? 10 : 0;
        const bBoost = b.boost_until && new Date(b.boost_until) > new Date() ? 10 : 0;
        return (b.similarity_score + bBoost) - (a.similarity_score + aBoost);
      })
      .slice(0, limit);

    // Strip hidden fields from results
    const sanitized = scored.map((item) => {
      if (item.user_id !== userId) {
        delete item.hidden_marks;
        delete item.hidden_contents;
        delete item.hidden_context;
      }
      return item;
    });

    res.json({
      source_item: source,
      matches: sanitized,
      total: sanitized.length,
      limit_applied: limit,
      user_credits: userCredits,
    });
  } catch (err) {
    console.error('getMatches error:', err);
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
}

// POST /matches/instant  — costs 2 credits
async function instantMatch(req, res) {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId is required' });

  const userId = req.user.id;
  const COST = 2;

  try {
    const deducted = await deductCredits(userId, COST);
    if (!deducted) {
      return res.status(402).json({ error: `Insufficient credits. Need ${COST} credits.` });
    }

    // Re-fetch updated user for match limit
    const [userRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    req.user = userRows[0];

    // Delegate to getMatches logic
    return getMatches(req, res);
  } catch (err) {
    console.error('instantMatch error:', err);
    res.status(500).json({ error: 'Failed to perform instant match' });
  }
}

// POST /items/:id/boost  — costs 10 credits (48 hrs)
async function boostItem(req, res) {
  const { id } = req.params;
  const userId = req.user.id;
  const COST = 10;

  try {
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    if (rows[0].user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    const deducted = await deductCredits(userId, COST);
    if (!deducted) {
      return res.status(402).json({ error: `Insufficient credits. Need ${COST} credits.` });
    }

    const boostUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await pool.execute('UPDATE items SET boost_until = ? WHERE id = ?', [boostUntil, id]);

    const [updated] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    res.json({ message: 'Item boosted for 48 hours', item: updated[0] });
  } catch (err) {
    console.error('boostItem error:', err);
    res.status(500).json({ error: 'Failed to boost item' });
  }
}

// POST /items/:id/request-ownership  — costs 20 credits
async function requestOwnership(req, res) {
  const { id } = req.params;
  const userId = req.user.id;
  const COST = 20;

  try {
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    if (item.user_id !== userId) return res.status(403).json({ error: 'Forbidden' });

    // Check claim window expired (10 days since created_at)
    const claimWindowDays = 10;
    const created = new Date(item.created_at);
    const expiry = new Date(created.getTime() + claimWindowDays * 24 * 60 * 60 * 1000);
    if (new Date() < expiry) {
      return res.status(400).json({ error: `Claim window has not expired yet. Expires on ${expiry.toISOString()}` });
    }

    if (item.status !== 'active') {
      return res.status(400).json({ error: 'Item is not in active status' });
    }

    const deducted = await deductCredits(userId, COST);
    if (!deducted) {
      return res.status(402).json({ error: `Insufficient credits. Need ${COST} credits.` });
    }

    await pool.execute("UPDATE items SET status = 'transferred' WHERE id = ?", [id]);

    const [updated] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    res.json({ message: 'Ownership transferred', item: updated[0] });
  } catch (err) {
    console.error('requestOwnership error:', err);
    res.status(500).json({ error: 'Failed to request ownership' });
  }
}

// POST /items/:id/smart-alert  — costs 3 credits
async function enableSmartAlert(req, res) {
  const { id } = req.params;
  const userId = req.user.id;
  const COST = 3;

  try {
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    // Check already subscribed
    const [existing] = await pool.execute(
      'SELECT * FROM smart_alerts WHERE user_id = ? AND item_id = ? AND active = 1',
      [userId, id]
    );
    if (existing.length) {
      return res.status(400).json({ error: 'Smart alert already active for this item' });
    }

    const deducted = await deductCredits(userId, COST);
    if (!deducted) {
      return res.status(402).json({ error: `Insufficient credits. Need ${COST} credits.` });
    }

    await pool.execute(
      'INSERT INTO smart_alerts (user_id, item_id) VALUES (?, ?)',
      [userId, id]
    );

    res.json({ message: 'Smart alert enabled. You will be notified when a match appears.' });
  } catch (err) {
    console.error('enableSmartAlert error:', err);
    res.status(500).json({ error: 'Failed to enable smart alert' });
  }
}

/**
 * Internal: Trigger smart alert notifications for a newly-created item.
 */
async function triggerSmartAlerts(newItem) {
  try {
    // Find active smart alerts for opposite-type items that could match
    const oppositeType = newItem.type === 'lost' ? 'found' : 'lost';
    const [alerts] = await pool.execute(
      `SELECT sa.user_id, sa.item_id, i.*
       FROM smart_alerts sa
       JOIN items i ON sa.item_id = i.id
       WHERE sa.active = 1 AND i.type = ? AND i.status = 'active'`,
      [oppositeType]
    );

    for (const alert of alerts) {
      const { similarity_score } = matchItems(newItem, alert);
      if (similarity_score >= 20) {
        await createNotification(
          alert.user_id,
          'smart_alert',
          `A new matching item was posted: "${newItem.title}" (score: ${similarity_score}%)`,
          newItem.id
        );
      }
    }
  } catch (err) {
    console.error('triggerSmartAlerts error:', err.message);
  }
}

// GET /items/stats  — aggregated dashboard stats
async function getStats(req, res) {
  try {
    const userId = req.user.id;
    const [global] = await pool.execute(
      `SELECT
         SUM(type = 'lost') AS lost,
         SUM(type = 'found') AS found,
         SUM(status = 'claimed') AS claimed,
         COUNT(*) AS total
       FROM items`
    );
    const [mine] = await pool.execute(
      `SELECT
         SUM(type = 'lost') AS my_lost,
         SUM(type = 'found') AS my_found,
         SUM(status = 'claimed') AS my_claimed,
         COUNT(*) AS my_total
       FROM items WHERE user_id = ?`,
      [userId]
    );
    const g = global[0];
    const m = mine[0];
    const recoveryRate = g.total > 0 ? Math.round((g.claimed / g.total) * 100) : 0;

    res.json({
      ...g,
      recovery_rate: recoveryRate,
      ...m,
    });
  } catch (err) {
    console.error('getStats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

module.exports = {
  getItems,
  getItemById,
  createItem,
  updateItem,
  deleteItem,
  getMatches,
  instantMatch,
  boostItem,
  requestOwnership,
  enableSmartAlert,
  getStats,
  // exported for reuse
  matchItems,
  awardCredits,
  deductCredits,
  createNotification,
};

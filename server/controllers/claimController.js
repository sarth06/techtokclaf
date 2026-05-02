'use strict';
const { pool } = require('../config/database');
const { awardCredits, deductCredits, createNotification } = require('./itemController');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple keyword scorer: how many keywords in the answer appear in the expected text.
 * Returns a 0–1 score.
 */
function scoreAnswer(answer, expectedText) {
  if (!answer || !expectedText) return 0;
  const answerTokens = answer.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const expectedTokens = new Set(
    expectedText.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1)
  );
  if (!answerTokens.length || !expectedTokens.size) return 0;

  let matched = 0;
  for (const token of answerTokens) {
    if (expectedTokens.has(token)) matched++;
  }
  return matched / Math.max(answerTokens.length, expectedTokens.size);
}

/**
 * Generate 3 verification questions from hidden item fields.
 */
function generateQuestions(item) {
  const questions = [];
  if (item.hidden_marks) {
    questions.push({
      id: 1,
      question: 'Describe any unique identifying marks on the item.',
      field: 'hidden_marks',
    });
  }
  if (item.hidden_contents) {
    questions.push({
      id: 2,
      question: 'What were the contents or items stored with/inside it?',
      field: 'hidden_contents',
    });
  }
  if (item.hidden_context) {
    questions.push({
      id: 3,
      question: 'Describe the circumstances or context of how it was lost.',
      field: 'hidden_context',
    });
  }

  // Fallback generic questions if hidden fields not set
  if (!questions.length) {
    questions.push(
      { id: 1, question: 'What is the color of the item?', field: null },
      { id: 2, question: 'What is the approximate size or weight?', field: null },
      { id: 3, question: 'Where exactly did you lose/find it?', field: null }
    );
  }

  return questions.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

// GET /claims/questions/:itemId  — get questions for claim
async function getClaimQuestions(req, res) {
  const { itemId } = req.params;
  try {
    const [rows] = await pool.execute('SELECT * FROM items WHERE id = ?', [itemId]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    if (item.status !== 'active') {
      return res.status(400).json({ error: 'Item is not claimable' });
    }

    const questions = generateQuestions(item);
    // Only return question text, not field name
    const sanitized = questions.map(({ id, question }) => ({ id, question }));
    res.json({ item_id: itemId, questions: sanitized });
  } catch (err) {
    console.error('getClaimQuestions error:', err);
    res.status(500).json({ error: 'Failed to fetch claim questions' });
  }
}

// POST /claims  — submit a claim
async function createClaim(req, res) {
  const { item_id, answers, proof_url } = req.body;
  const claimantId = req.user.id;

  if (!item_id) return res.status(400).json({ error: 'item_id is required' });
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: 'answers must be an object' });
  }

  try {
    // Fetch item
    const [itemRows] = await pool.execute('SELECT * FROM items WHERE id = ?', [item_id]);
    if (!itemRows.length) return res.status(404).json({ error: 'Item not found' });
    const item = itemRows[0];

    if (item.status !== 'active') {
      return res.status(400).json({ error: 'Item is not claimable' });
    }

    // Self-recovery check
    if (item.user_id === claimantId) {
      await pool.execute(
        "UPDATE items SET status = 'self_recovered', claimed_at = NOW() WHERE id = ?",
        [item_id]
      );
      return res.status(200).json({
        message: 'Self Recovered — no credits awarded.',
        status: 'self_recovered',
      });
    }

    // Check existing claims for this user on this item
    const [existingClaims] = await pool.execute(
      'SELECT * FROM claims WHERE item_id = ? AND claimant_id = ?',
      [item_id, claimantId]
    );

    if (existingClaims.length >= 3) {
      return res.status(400).json({ error: 'Maximum 3 claim attempts reached for this item.' });
    }

    const attemptNumber = existingClaims.length + 1;

    // Generate questions + score answers
    const questions = generateQuestions(item);
    let totalScore = 0;
    let scoredCount = 0;

    for (const q of questions) {
      if (!q.field) continue; // generic question — skip scoring
      const userAnswer = answers[q.id] || '';
      const expected = item[q.field] || '';
      totalScore += scoreAnswer(userAnswer, expected);
      scoredCount++;
    }

    const confidence_score = scoredCount > 0 ? totalScore / scoredCount : 0.5;
    const confidence_label = confidence_score >= 0.7 ? 'High Confidence' : 'Low Confidence';

    // Insert claim
    const [result] = await pool.execute(
      `INSERT INTO claims
         (item_id, claimant_id, answers, confidence_score, status, attempts, proof_url)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [
        item_id,
        claimantId,
        JSON.stringify(answers),
        confidence_score.toFixed(3),
        attemptNumber,
        proof_url || null,
      ]
    );

    // Notify item owner
    await createNotification(
      item.user_id,
      'new_claim',
      `A new claim (${confidence_label}) was submitted for your item "${item.title}".`,
      item_id
    );

    const [created] = await pool.execute('SELECT * FROM claims WHERE id = ?', [result.insertId]);
    res.status(201).json({
      ...created[0],
      confidence_label,
      attempt_number: attemptNumber,
    });
  } catch (err) {
    console.error('createClaim error:', err);
    res.status(500).json({ error: 'Failed to submit claim' });
  }
}

// GET /claims  — list claims (owner sees claims on their items; claimant sees their own)
async function getClaims(req, res) {
  const userId = req.user.id;
  try {
    const [rows] = await pool.execute(
      `SELECT c.*, i.title AS item_title, i.type AS item_type, i.user_id AS item_owner_id,
              u.email AS claimant_email
       FROM claims c
       JOIN items i ON c.item_id = i.id
       JOIN users u ON c.claimant_id = u.id
       WHERE c.claimant_id = ? OR i.user_id = ?
       ORDER BY c.created_at DESC`,
      [userId, userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('getClaims error:', err);
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
}

// PUT /claims/:id  — approve or reject a claim (item owner only)
async function updateClaim(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  const userId = req.user.id;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be "approved" or "rejected"' });
  }

  try {
    const [claimRows] = await pool.execute(
      `SELECT c.*, i.user_id AS item_owner_id, i.title AS item_title,
              i.type AS item_type
       FROM claims c JOIN items i ON c.item_id = i.id
       WHERE c.id = ?`,
      [id]
    );
    if (!claimRows.length) return res.status(404).json({ error: 'Claim not found' });

    const claim = claimRows[0];
    if (claim.item_owner_id !== userId) {
      return res.status(403).json({ error: 'Only the item owner can approve or reject claims' });
    }
    if (claim.status !== 'pending') {
      return res.status(400).json({ error: 'Claim is no longer pending' });
    }

    await pool.execute(
      'UPDATE claims SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );

    if (status === 'approved') {
      // Mark item as claimed
      await pool.execute(
        "UPDATE items SET status = 'claimed', claimed_at = NOW() WHERE id = ?",
        [claim.item_id]
      );
      // Award credits to both parties
      await awardCredits(claim.item_owner_id, 10); // successful return
      await awardCredits(claim.claimant_id, 10);

      // Notify claimant
      await createNotification(
        claim.claimant_id,
        'claim_approved',
        `Your claim for "${claim.item_title}" has been approved! +10 credits awarded.`,
        claim.item_id
      );
    } else {
      // Deduct 2 credits from claimant for failed claim
      await deductCredits(claim.claimant_id, 2);

      await createNotification(
        claim.claimant_id,
        'claim_rejected',
        `Your claim for "${claim.item_title}" was rejected. 2 credits deducted.`,
        claim.item_id
      );
    }

    const [updated] = await pool.execute('SELECT * FROM claims WHERE id = ?', [id]);
    res.json(updated[0]);
  } catch (err) {
    console.error('updateClaim error:', err);
    res.status(500).json({ error: 'Failed to update claim' });
  }
}

module.exports = { getClaimQuestions, createClaim, getClaims, updateClaim };

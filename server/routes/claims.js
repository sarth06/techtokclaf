'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
  getClaimQuestions,
  createClaim,
  getClaims,
  updateClaim,
} = require('../controllers/claimController');

router.use(authenticate);

router.get('/questions/:itemId', getClaimQuestions);
router.post('/', createClaim);
router.get('/', getClaims);
router.put('/:id', updateClaim);

module.exports = router;

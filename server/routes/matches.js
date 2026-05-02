'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { getMatches, instantMatch } = require('../controllers/itemController');

router.use(authenticate);

router.get('/:itemId', getMatches);
router.post('/instant', instantMatch);

module.exports = router;

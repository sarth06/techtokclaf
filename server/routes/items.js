'use strict';
const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const {
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
} = require('../controllers/itemController');

// All routes require authentication
router.use(authenticate);

// Stats (must come before /:id)
router.get('/stats', getStats);

// Matching routes (must come before /:id wildcard)
router.get('/matches/:itemId', getMatches);
router.post('/matches/instant', instantMatch);

// CRUD
router.get('/', getItems);
router.post('/', createItem);
router.get('/:id', getItemById);
router.put('/:id', updateItem);
router.delete('/:id', deleteItem);

// Credit actions (specific sub-paths before generic /:id already handled above)
router.post('/:id/boost', boostItem);
router.post('/:id/request-ownership', requestOwnership);
router.post('/:id/smart-alert', enableSmartAlert);

module.exports = router;

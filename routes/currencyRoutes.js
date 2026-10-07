const express = require('express');
const router = express.Router();
const currencyController = require('../controllers/currencyController');

router.get('/', currencyController.getAllCurrencies);
router.post('/', currencyController.createCurrency);
router.put('/:id', currencyController.updateCurrency);

module.exports = router;

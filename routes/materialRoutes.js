const express = require('express');
const router = express.Router();
const materialController = require('../controllers/materialController');

router.get('/', materialController.getAllMaterials);
router.post('/', materialController.createMaterial);
router.get('/suppliers', materialController.getSuppliers);
router.post('/import', materialController.importMaterials);
// Must be registered before '/:id' so "bulk" isn't treated as an id
router.put('/bulk', materialController.bulkUpdateMaterials);

router.get('/:id', materialController.getMaterialById);
router.put('/:id', materialController.updateMaterial);

module.exports = router;

const express = require('express');
const router = express.Router();
const templateController = require('../controllers/templateController');

router.get('/section-topics', templateController.getExistingSectionTopics);
router.get('/cost-names', templateController.getExistingCostNames);
router.get('/section2-names', templateController.getExistingSection2Names);
router.get('/spec-titles', templateController.getExistingSpecTitles);

router.get('/', templateController.getAllTemplates);
router.post('/', templateController.createTemplate);
router.get('/:id', templateController.getTemplateById);
router.put('/:id', templateController.updateTemplate);

module.exports = router;
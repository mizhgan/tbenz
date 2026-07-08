const { Router } = require('express');
const {
  getStatus,
  listChats,
  updateChat,
  deleteChat,
  testMessage,
} = require('../controllers/telegram.controller');
const { requireAuth, requireAdmin } = require('../middleware/auth.middleware');

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/status', getStatus);
router.get('/chats', listChats);
router.put('/chats/:id', updateChat);
router.delete('/chats/:id', deleteChat);
router.post('/chats/:id/test', testMessage);

module.exports = router;

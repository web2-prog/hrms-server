import { Router } from 'express';
import * as auth from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();
router.post('/login', auth.login);
router.get('/me', authenticate, auth.me);
router.post('/change-password', authenticate, auth.changePassword);
export default router;

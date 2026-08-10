import { Router } from 'express';
import * as ctrl from '../controllers/analyticsController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.get('/', authenticate, authorize('admin', 'hr'), ctrl.getAnalytics);
export default router;

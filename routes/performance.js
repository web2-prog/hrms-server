import { Router } from 'express';
import * as ctrl from '../controllers/performanceController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr'), ctrl.list);
router.post('/shortfall-decision', authorize('admin', 'hr'), ctrl.decideShortfall);
export default router;

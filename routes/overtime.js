import { Router } from 'express';
import * as ctrl from '../controllers/overtimeController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr', 'employee'), ctrl.list);
router.post('/', authorize('admin', 'hr', 'employee'), ctrl.apply);
router.patch('/:id/decide', authorize('admin', 'hr'), ctrl.decide);
export default router;

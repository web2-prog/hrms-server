import { Router } from 'express';
import * as ctrl from '../controllers/holidayController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr', 'employee'), ctrl.list);
router.post('/', authorize('admin', 'hr'), ctrl.create);
router.delete('/:id', authorize('admin', 'hr'), ctrl.remove);
export default router;

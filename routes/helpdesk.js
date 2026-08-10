import { Router } from 'express';
import * as ctrl from '../controllers/helpdeskController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr', 'employee'), ctrl.list);
router.get('/:id', authorize('admin', 'hr', 'employee'), ctrl.getOne);
router.post('/', authorize('admin', 'hr', 'employee'), ctrl.create);
router.patch('/:id/respond', authorize('admin', 'hr'), ctrl.respond);
router.delete('/:id', authorize('admin', 'hr', 'employee'), ctrl.remove);
export default router;

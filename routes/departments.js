import { Router } from 'express';
import * as ctrl from '../controllers/departmentController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr', 'employee'), ctrl.list);
router.get('/:id', authorize('admin', 'hr'), ctrl.getOne);
router.post('/', authorize('admin'), ctrl.create);
router.put('/:id', authorize('admin'), ctrl.update);
router.delete('/:id', authorize('admin'), ctrl.remove);
export default router;

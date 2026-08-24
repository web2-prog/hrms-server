import { Router } from 'express';
import * as ctrl from '../controllers/employeeController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { uploadPhoto } from '../middleware/upload.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr'), ctrl.list);
router.get('/:id', authorize('admin', 'hr', 'employee'), ctrl.getOne);
router.post('/', authorize('admin', 'hr'), uploadPhoto.single('photo'), ctrl.create);
router.put('/:id', authorize('admin', 'hr'), uploadPhoto.single('photo'), ctrl.update);
router.post('/:id/reset-password', authorize('admin', 'hr'), ctrl.resetPassword);
router.post('/:id/clear-data', authorize('admin'), ctrl.clearData);
export default router;

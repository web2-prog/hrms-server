import { Router } from 'express';
import * as ctrl from '../controllers/salaryController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.get('/', authorize('admin', 'hr', 'employee'), ctrl.list);
router.post('/generate', authorize('admin', 'hr'), ctrl.generate);
router.post('/generate-bulk', authorize('admin'), ctrl.generateBulk);
router.get('/:id', authorize('admin', 'hr', 'employee'), ctrl.getOne);
router.post('/:id/finalize', authorize('admin', 'hr'), ctrl.finalize);
router.post('/:id/reverse', authorize('admin'), ctrl.reverse);
router.patch('/:id/payment', authorize('admin', 'hr'), ctrl.updatePayment);
router.patch('/:id/company', authorize('admin', 'hr'), ctrl.updateCompany);
router.patch('/:id/adjust', authorize('admin', 'hr'), ctrl.updateAdjustments);
router.post('/:id/send', authorize('admin', 'hr'), ctrl.sendSlip);
router.get('/:id/pdf', authorize('admin', 'hr', 'employee'), ctrl.downloadPdf);
export default router;

import { Router } from 'express';
import * as ctrl from '../controllers/miscController.js';
import { authenticate, authorize } from '../middleware/auth.js';

const router = Router();
router.get('/working-days', authenticate, authorize('admin', 'hr', 'employee'), ctrl.workingDays);
router.get('/audit-logs', authenticate, authorize('admin'), ctrl.listAudit);
router.get('/settings', authenticate, authorize('admin'), ctrl.getSystemSettings);
router.put('/settings', authenticate, authorize('admin'), ctrl.updateSystemSettings);
router.get('/monthly-summary', authenticate, authorize('admin', 'hr', 'employee'), ctrl.getMonthlySummary);
export default router;

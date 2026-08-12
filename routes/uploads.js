import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { authenticate } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '..', 'uploads');

const router = Router();

router.get('/:filename', (req, res, next) => {
  if (req.query.access_token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.access_token}`;
  }
  authenticate(req, res, next);
}, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename || filename.startsWith('.')) {
    return res.status(400).json({ message: 'Invalid filename' });
  }
  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ message: 'Not found' });
  }
  res.sendFile(filePath);
});

export default router;

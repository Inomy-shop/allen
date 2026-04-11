import { Router, type Request, type Response } from 'express';
import { existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import multer from 'multer';

const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(process.cwd(), '..', '..', 'uploads');

// Ensure uploads dir exists
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const id = randomUUID();
    const ext = extname(file.originalname);
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

export function fileRoutes(): Router {
  const router = Router();

  // POST /api/files — upload a file, returns public URL
  router.post('/', upload.single('file'), (req: Request, res: Response) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const filename = file.filename;
    const url = `/api/files/${filename}`;

    res.status(201).json({
      filename,
      originalName: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
      url,
    });
  });

  // POST /api/files/from-content — create a file from text content (used by agents/MCP)
  router.post('/from-content', (req: Request, res: Response) => {
    const { content, filename: requestedName, mimeType } = req.body;
    if (!content || !requestedName) {
      return res.status(400).json({ error: 'content and filename are required' });
    }

    const id = randomUUID();
    const ext = extname(requestedName);
    const storedName = `${id}${ext}`;
    const fullPath = join(UPLOADS_DIR, storedName);

    const { writeFileSync } = require('node:fs');
    writeFileSync(fullPath, content, 'utf-8');

    const url = `/api/files/${storedName}`;
    res.status(201).json({
      filename: storedName,
      originalName: requestedName,
      size: Buffer.byteLength(content, 'utf-8'),
      mimeType: mimeType ?? 'text/plain',
      url,
    });
  });

  // GET /api/files/:filename — serve a file publicly
  router.get('/:filename', (req: Request, res: Response) => {
    const filename = Array.isArray(req.params.filename) ? req.params.filename[0] : req.params.filename;
    // Prevent path traversal
    if (filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = join(UPLOADS_DIR, filename);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.sendFile(filePath);
  });

  return router;
}

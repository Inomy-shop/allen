import { Router, type Request, type Response } from 'express';
import { addSSEClient } from '../services/stream.service.js';
import { param } from '../types.js';

export function streamRoutes(): Router {
  const router = Router();

  // GET /api/executions/:id/stream
  router.get('/:id/stream', (req: Request, res: Response) => {
    addSSEClient(param(req, 'id'), res);
  });

  return router;
}

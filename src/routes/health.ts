import { Router } from 'express';
import { routeTable } from '../utils/routeTable.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', routes: routeTable.get().length });
});

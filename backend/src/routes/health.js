import { Router } from 'express';
import { config } from '../config/index.js';
import { listUnderlyings } from '../data/instrumentResolver.js';

export function healthRouter({ adapterManager, rollingStore }) {
  const router = Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, mode: config.dataMode, uptime: process.uptime() });
  });

  router.get('/status', (req, res) => {
    res.json({
      ...adapterManager.getStatus(),
      symbols: rollingStore.allSymbols().map((s) => rollingStore.forSymbol(s).summary())
    });
  });

  router.get('/instruments', (req, res) => {
    res.json({ underlyings: listUnderlyings() });
  });

  return router;
}

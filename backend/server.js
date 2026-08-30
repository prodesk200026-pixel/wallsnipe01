import express from 'express';
import cors from 'cors';
import { createServer } from 'http';

import { config } from './src/config/index.js';
import { AdapterManager } from './src/adapters/AdapterManager.js';
import { RollingMarketStore } from './src/stores/RollingMarketStore.js';
import { CandleStore } from './src/market/candleStore.js';
import { runEngineChain } from './src/engines/pipeline.js';
import { attachSocket } from './src/socket/index.js';
import { healthRouter } from './src/routes/health.js';
import { resolveMicrostructureInstrument, listUnderlyings } from './src/data/instrumentResolver.js';
import { initPush, isPushConfigured, addSubscription, removeSubscription } from './src/push/pushManager.js';
import { withOiVolumeChange } from './src/options/oiVolumeTracker.js';
import { computeMaxPain } from './src/options/maxPainEngine.js';
import { computeFullGreeks } from './src/options/greeksEngine.js';

/**
 * SIGNAL-ONLY APPLICATION.
 * This server does not, and must never, place, modify, or cancel
 * orders. There is no order-placement route, no broker order API
 * call, and no code path that executes a trade. All output is
 * read-only market intelligence for a human to act on manually.
 */

const app = express();
app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    service: 'Wall Sniper Live backend',
    status: 'ok',
    dataMode: config.dataMode,
    hint: "Health check is at /api/health. This root route exists so Render pings and manual URL checks don't show a scary 404."
  });
});

const rollingStore = new RollingMarketStore();
const adapterManager = new AdapterManager();
const candleStore = new CandleStore();

app.use('/api', healthRouter({ adapterManager, rollingStore }));

app.get('/api/candles', (req, res) => {
  const { symbol, timeframe = '5m', limit = 100 } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol query param required' });
  if (!CandleStore.supportedTimeframes.includes(timeframe)) {
    return res.status(400).json({ error: `unsupported timeframe. use one of: ${CandleStore.supportedTimeframes.join(', ')}` });
  }
  res.json({
    symbol,
    timeframe,
    candles: candleStore.getCandles(symbol, timeframe, Number(limit))
  });
});

// Explicit guard: reject anything that looks like an order-placement
// request, in case a future contributor adds one by mistake.
app.all('/api/order*', (req, res) => {
  res.status(403).json({
    error: 'FORBIDDEN',
    message: 'This is a signal-only application. Order placement is not implemented and will not be added to this API.'
  });
});

// --- Push alarm registration (mobile "phone rings on signal") ---
initPush();

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: config.vapid.publicKey, configured: isPushConfigured() });
});

app.post('/api/push/subscribe', (req, res) => {
  addSubscription(req.body);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  removeSubscription(req.body?.endpoint);
  res.json({ ok: true });
});

const httpServer = createServer(app);
attachSocket(httpServer, { adapterManager, rollingStore, runEngineChain, candleStore });

async function start() {
  await adapterManager.start();

  const trackedSymbols = listUnderlyings();
  const instruments = trackedSymbols.map((sym) => resolveMicrostructureInstrument(sym));

  adapterManager.onQuote((quote, provider) => {
    const symbol = quote.symbol.replace('-FUT', '');
    rollingStore.forSymbol(symbol).pushQuote(quote);
    candleStore.onTick(symbol, quote);
  });
  adapterManager.onDepth((depth, provider) => {
    rollingStore.forSymbol(depth.symbol.replace('-FUT', '')).pushDepth(depth);
  });

  await adapterManager.subscribe(instruments);
  await adapterManager.subscribeDepth(instruments); // AdapterManager picks the right depth level per active broker

  // Option chain poller — Engines 12-14 need periodic snapshots.
  // REST-based (not streamed) since option chain updates far less
  // frequently than the underlying tick stream. Interval is padded
  // well above the worst case of 3 symbols x Dhan's 1-req/3s option
  // chain rate limit (see DhanAdapter._optionChainRateLimit) so the
  // poller never overlaps itself waiting on that gate. `running`
  // guards against a slow cycle overlapping the next scheduled one.
  const OPTION_CHAIN_POLL_MS = 20000;
  let optionPollRunning = false;
  setInterval(async () => {
    if (optionPollRunning) return;
    optionPollRunning = true;
    try {
      for (const symbol of trackedSymbols) {
        try {
          let chain = await adapterManager.getOptionChain(symbol); // no expiry override — each adapter resolves the real nearest expiry itself
          if (!chain) continue;

          // Enrich: OI/volume change (uniform across both brokers),
          // max pain, and full Greeks (broker's own delta/gamma/theta/
          // vega where supplied, always-computed IV/rho/hidden Greeks
          // otherwise) — see src/options/ for why each of these exists.
          chain = withOiVolumeChange(chain);
          chain.maxPain = computeMaxPain(chain);
          for (const row of chain.strikes) {
            for (const legType of ['CE', 'PE']) {
              const leg = row[legType];
              if (!leg || leg.ltp == null || chain.spot == null) continue;
              leg.greeks = computeFullGreeks({
                optionType: legType,
                spot: chain.spot,
                strike: row.strike,
                expiryDate: chain.expiry,
                ltp: leg.ltp,
                brokerGreeks: leg.greeks,
                brokerIV: leg.iv
              });
            }
          }

          rollingStore.forSymbol(symbol).pushOptionSnapshot(chain);
        } catch (err) {
          // Option chain is best-effort; engines correctly report
          // UNAVAILABLE when no snapshot has landed yet.
        }
      }
    } finally {
      optionPollRunning = false;
    }
  }, OPTION_CHAIN_POLL_MS);

  httpServer.listen(config.port, () => {
    console.log(`WALL SNIPER LIVE backend listening on :${config.port}`);
    console.log(`DATA_MODE=${config.dataMode}  PRIMARY_BROKER=${config.primaryBroker}  SECONDARY_BROKER=${config.secondaryBroker}`);
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

import { Server } from 'socket.io';
import { config } from '../config/index.js';
import { sendSignalAlarm } from '../push/pushManager.js';

/**
 * Thin Socket.IO layer. Frontend subscribes to a symbol room and
 * receives throttled pipeline output. No trading actions are ever
 * accepted from the client side — this is push-only, signal-only.
 */
export function attachSocket(httpServer, { adapterManager, rollingStore, runEngineChain }) {
  const io = new Server(httpServer, {
    cors: { origin: config.frontendOrigin, methods: ['GET', 'POST'] }
  });

  // Tracks the last signalId we already alarmed on per symbol, so a
  // signal that's still SIGNAL_ACTIVE across many broadcast ticks
  // only ever fires the phone alarm once.
  const lastAlarmedSignalId = new Map();

  io.on('connection', (socket) => {
    socket.emit('provider:status', adapterManager.getStatus());

    socket.on('subscribe:symbol', (symbol) => {
      socket.join(`symbol:${symbol}`);
      const store = rollingStore.forSymbol(symbol);
      socket.emit('engine:update', runEngineChain(store));
    });

    socket.on('unsubscribe:symbol', (symbol) => {
      socket.leave(`symbol:${symbol}`);
    });
  });

  adapterManager.onStatusChange((payload) => {
    io.emit('provider:status', { ...adapterManager.getStatus(), event: payload });
  });

  // Throttled broadcast loop — avoids flooding the socket on every
  // single tick while still feeling live on mobile.
  const BROADCAST_INTERVAL_MS = 700;
  setInterval(() => {
    rollingStore.tickStaleCheck();
    for (const symbol of rollingStore.allSymbols()) {
      const store = rollingStore.forSymbol(symbol);
      if (!store.lastUpdate) continue;
      const output = runEngineChain(store);
      io.to(`symbol:${symbol}`).emit('engine:update', output);

      const signal = output.signal;
      if (signal?.status === 'SIGNAL_ACTIVE' && signal.signalId && lastAlarmedSignalId.get(symbol) !== signal.signalId) {
        lastAlarmedSignalId.set(symbol, signal.signalId);
        sendSignalAlarm({
          symbol,
          direction: signal.direction,
          grade: signal.grade,
          strike: signal.recommendedContract ? `${signal.recommendedContract.strike} ${signal.direction === 'BULLISH' ? 'CE' : 'PE'}` : null
        }).catch(() => {}); // sendSignalAlarm already logs; never let a push failure break the broadcast loop
      }
    }
  }, BROADCAST_INTERVAL_MS);

  return io;
}


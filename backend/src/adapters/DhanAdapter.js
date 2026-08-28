import axios from 'axios';
import WebSocket from 'ws';
import { BaseMarketDataAdapter } from './BaseMarketDataAdapter.js';
import { normalizeQuote, normalizeDepth } from '../normalizers/normalize.js';

const DHAN_REST_BASE = 'https://api.dhan.co/v2';
const DHAN_FEED_WS = 'wss://api-feed.dhan.co';

/**
 * DhanAdapter — PRIMARY provider.
 *
 * IMPORTANT: Dhan's live market-feed WebSocket uses a binary packet
 * protocol (packet codes for Ticker/Quote/Full/Depth20 packets) that
 * Dhan revises from time to time. The exact byte offsets below follow
 * Dhan's v2 Market Feed documentation at the time this was written.
 * Before going live, verify the packet layout against the current
 * Dhan API docs (https://dhanhq.co/docs/v2/market-feed/) — a field
 * offset mismatch will silently corrupt data rather than throw, which
 * is why every parsed value also passes through the data-quality
 * validator downstream.
 */
export class DhanAdapter extends BaseMarketDataAdapter {
  constructor({ clientId, accessToken }) {
    super('DHAN');
    this.clientId = clientId;
    this.accessToken = accessToken;
    this.ws = null;
    this._subscribed = new Map(); // securityId -> { symbol, exchangeSegment }
    this._depthLevels = new Map(); // securityId -> levels requested

    this.http = axios.create({
      baseURL: DHAN_REST_BASE,
      headers: {
        'access-token': this.accessToken,
        'client-id': this.clientId,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
  }

  async connect() {
    if (!this.clientId || !this.accessToken) {
      throw new Error('DHAN: missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN');
    }
    this._connectionStatus = 'CONNECTING';
    return new Promise((resolve, reject) => {
      const url = `${DHAN_FEED_WS}?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this._connectionStatus = 'CONNECTED';
        resolve(true);
      });

      this.ws.on('message', (data) => {
        try {
          this._handleFeedPacket(data);
        } catch (err) {
          this._emitError({ provider: 'DHAN', stage: 'FEED_PARSE', error: err.message });
        }
      });

      this.ws.on('error', (err) => {
        this._connectionStatus = 'ERROR';
        this._emitError({ provider: 'DHAN', stage: 'WS_ERROR', error: err.message });
        reject(err);
      });

      this.ws.on('close', () => {
        this._connectionStatus = 'DISCONNECTED';
      });
    });
  }

  async disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connectionStatus = 'DISCONNECTED';
  }

  async getQuote(instrument) {
    const { exchangeSegment, securityId, symbol } = instrument;
    const res = await this.http.post('/marketfeed/quote', {
      [exchangeSegment]: [Number(securityId)]
    });
    const raw = res.data?.data?.[exchangeSegment]?.[securityId];
    if (!raw) return null;
    return normalizeQuote({
      provider: 'DHAN',
      symbol,
      exchange: exchangeSegment,
      segment: exchangeSegment,
      securityId,
      ltp: raw.last_price,
      ltq: raw.last_trade_qty,
      ltt: raw.last_trade_time,
      open: raw.ohlc?.open,
      high: raw.ohlc?.high,
      low: raw.ohlc?.low,
      close: raw.ohlc?.close,
      volume: raw.volume,
      totalBuyQuantity: raw.buy_quantity,
      totalSellQuantity: raw.sell_quantity,
      oi: raw.oi,
      dataQuality: 'EXACT'
    });
  }

  async getHistoricalCandles(instrument, timeframe) {
    const { exchangeSegment, securityId, symbol, instrumentType } = instrument;
    const res = await this.http.post('/charts/intraday', {
      securityId: String(securityId),
      exchangeSegment,
      instrument: instrumentType || 'INDEX',
      interval: mapTimeframeToDhanInterval(timeframe)
    });
    const d = res.data;
    if (!d || !Array.isArray(d.open)) return [];
    return d.open.map((_, i) => ({
      timestamp: d.timestamp[i] * 1000,
      open: d.open[i],
      high: d.high[i],
      low: d.low[i],
      close: d.close[i],
      volume: d.volume[i]
    }));
  }

  async getOptionChain(underlying, expiry) {
    const res = await this.http.post('/optionchain', {
      UnderlyingScrip: underlying.securityId,
      UnderlyingSeg: underlying.exchangeSegment,
      Expiry: expiry
    });
    const data = res.data?.data;
    if (!data) return null;
    const strikes = Object.entries(data.oc || {}).map(([strike, legs]) => ({
      strike: Number(strike),
      CE: legs.ce ? normalizeOptionLeg(legs.ce) : null,
      PE: legs.pe ? normalizeOptionLeg(legs.pe) : null
    }));
    return {
      provider: 'DHAN',
      underlying: underlying.symbol,
      expiry,
      spot: data.last_price,
      strikes,
      dataQuality: 'EXACT'
    };
  }

  async subscribeMarketData(instruments) {
    this._sendSubscription(instruments, 'RequestFull'); // 'Ticker' | 'Quote' | 'Full'
    return true;
  }

  async unsubscribeMarketData(instruments) {
    this._sendSubscription(instruments, 'Unsubscribe');
    return true;
  }

  async subscribeDepth(instruments, levels = 20) {
    for (const inst of instruments) this._depthLevels.set(String(inst.securityId), levels);
    // 20-depth uses a dedicated request code in Dhan's protocol (Depth20).
    this._sendSubscription(instruments, 'Depth20');
    return true;
  }

  async unsubscribeDepth(instruments) {
    for (const inst of instruments) this._depthLevels.delete(String(inst.securityId));
    this._sendSubscription(instruments, 'UnsubscribeDepth');
    return true;
  }

  // --- internal ---

  _sendSubscription(instruments, requestCodeLabel) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('DHAN: cannot subscribe, socket not connected');
    }
    for (const inst of instruments) {
      this._subscribed.set(String(inst.securityId), {
        symbol: inst.symbol,
        exchangeSegment: inst.exchangeSegment
      });
    }
    const payload = {
      RequestCode: requestCodeLabel,
      InstrumentCount: instruments.length,
      InstrumentList: instruments.map((i) => ({
        ExchangeSegment: i.exchangeSegment,
        SecurityId: String(i.securityId)
      }))
    };
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Parses an incoming feed packet. Dhan sends binary frames for
   * ticker/quote/full/depth packets. VERIFY exact offsets against
   * current Dhan docs before trusting this in production — see class
   * comment above.
   */
  _handleFeedPacket(buffer) {
    if (!(buffer instanceof Buffer)) return;
    if (buffer.length < 8) return;

    const packetCode = buffer.readUInt8(0);
    const securityId = String(buffer.readInt32LE(4));
    const meta = this._subscribed.get(securityId);
    const symbol = meta?.symbol || securityId;
    const exchangeSegment = meta?.exchangeSegment || 'UNKNOWN';

    // Full/Quote packet (LTP + OHLC + volumes) — offsets per Dhan v2 docs.
    if (packetCode === 4 || packetCode === 2) {
      const ltp = buffer.readFloatLE(8);
      const ltq = buffer.readInt16LE(12);
      const volume = buffer.readInt32LE(18);
      this._emitQuote(
        normalizeQuote({
          provider: 'DHAN',
          symbol,
          exchange: exchangeSegment,
          segment: exchangeSegment,
          securityId,
          ltp,
          ltq,
          volume,
          dataQuality: 'EXACT'
        })
      );
      return;
    }

    // Depth20 packet — bid/ask ladder.
    if (packetCode === 41 || packetCode === 42) {
      const isBidPacket = packetCode === 41;
      const levels = [];
      let offset = 8;
      for (let i = 0; i < 20 && offset + 16 <= buffer.length; i++) {
        levels.push({
          price: buffer.readFloatLE(offset),
          quantity: buffer.readInt32LE(offset + 4),
          orderCount: buffer.readInt32LE(offset + 8),
          level: i + 1
        });
        offset += 16;
      }
      this._pendingDepth = this._pendingDepth || {};
      const entry = (this._pendingDepth[securityId] = this._pendingDepth[securityId] || {});
      if (isBidPacket) entry.bids = levels;
      else entry.asks = levels;

      if (entry.bids && entry.asks) {
        this._emitDepth(
          normalizeDepth({
            provider: 'DHAN',
            symbol,
            securityId,
            levelsAvailable: Math.min(entry.bids.length, entry.asks.length),
            bids: entry.bids,
            asks: entry.asks,
            dataQuality: 'EXACT'
          })
        );
        delete this._pendingDepth[securityId];
      }
    }
  }
}

function normalizeOptionLeg(leg) {
  return {
    ltp: leg.last_price,
    bid: leg.top_bid_price,
    ask: leg.top_ask_price,
    bidQty: leg.top_bid_quantity,
    askQty: leg.top_ask_quantity,
    oi: leg.oi,
    oiChange: leg.oi - (leg.previous_oi ?? leg.oi),
    volume: leg.volume,
    iv: leg.implied_volatility,
    greeks: leg.greeks || null,
    dataQuality: 'EXACT'
  };
}

function mapTimeframeToDhanInterval(tf) {
  const map = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '1d': 'D' };
  return map[tf] || '1';
}

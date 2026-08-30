import axios from 'axios';
import WebSocket from 'ws';
import { BaseMarketDataAdapter } from './BaseMarketDataAdapter.js';
import { normalizeQuote, normalizeDepth } from '../normalizers/normalize.js';
import { generateTOTP } from '../auth/totp.js';
import { getNearestExpiry, getOptionChainTokens, getIndexToken } from '../data/angelInstrumentMaster.js';

const ANGEL_REST_BASE = 'https://apiconnect.angelone.in';
const ANGEL_WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

/**
 * AngelAdapter — SECONDARY / FALLBACK provider.
 *
 * Angel One SmartAPI gives best-5 depth only (not 20/200-level), so
 * this adapter must never claim deeper depth than it has. Login uses
 * TOTP-based 2FA; verify current auth flow against SmartAPI docs
 * (https://smartapi.angelbroking.com/docs) as Angel periodically
 * revises token lifetimes and header names.
 */
export class AngelAdapter extends BaseMarketDataAdapter {
  constructor({ apiKey, clientCode, pin, totpSecret }) {
    super('ANGEL');
    this.apiKey = apiKey;
    this.clientCode = clientCode;
    this.pin = pin;
    this.totpSecret = totpSecret;
    this.jwtToken = null;
    this.feedToken = null;
    this.ws = null;
    this._subscribed = new Map();
    this._intentionalDisconnect = false; // true only when WE call disconnect() — lets 'close' tell intentional teardown apart from Angel dropping us

    // Angel's docs list X-ClientLocalIP / X-ClientPublicIP /
    // X-MACAddress / X-PrivateKey as REQUIRED on loginByPassword
    // itself, not just on later calls. Missing/empty X-PrivateKey at
    // login time is a documented cause of a plain 400 with no useful
    // body — this used to be blank here until after login succeeded,
    // which is backwards. Real IP/MAC values aren't actually
    // validated by Angel in practice (community reports placeholder
    // values like 127.0.0.1 / a fixed MAC work fine) — what matters
    // is that the headers are present and non-empty.
    this.http = axios.create({
      baseURL: ANGEL_REST_BASE,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '106.51.74.62',
        'X-MACAddress': 'fe:dc:ba:98:76:54',
        'X-PrivateKey': apiKey || ''
      }
    });
  }

  async connect() {
    if (!this.apiKey || !this.clientCode || !this.pin || !this.totpSecret) {
      throw new Error('ANGEL: missing ANGEL_API_KEY / ANGEL_CLIENT_CODE / ANGEL_PIN / ANGEL_TOTP_SECRET');
    }
    this._intentionalDisconnect = false;
    this._connectionStatus = 'CONNECTING';

    const totp = generateTOTP(this.totpSecret);
    let loginRes;
    try {
      loginRes = await this.http.post('/rest/auth/angelbroking/user/v1/loginByPassword', {
        clientcode: this.clientCode,
        password: this.pin,
        totp
      });
    } catch (err) {
      const angelBody = err.response?.data;
      // Angel changed their login policy — many accounts (especially
      // newly opened ones) now get "LoginbyPassword is not allowed.
      // Please switch to Login by MPIN now." from this endpoint.
      // Auto-fallback to the MPIN endpoint on exactly that signal —
      // most Angel users' "PIN" already IS their MPIN in current
      // terminology, so this is safe to retry with the same value.
      if (/mpin/i.test(angelBody?.message || '')) {
        try {
          loginRes = await this.http.post('/rest/auth/angelbroking/user/v1/loginByMPIN', {
            clientcode: this.clientCode,
            mpin: this.pin,
            totp
          });
        } catch (mpinErr) {
          const mpinBody = mpinErr.response?.data;
          throw new Error(
            `ANGEL: loginByPassword required MPIN, but loginByMPIN also failed — ${mpinBody ? JSON.stringify(mpinBody) : mpinErr.message}`
          );
        }
      } else {
        // Angel's actual error body (message/errorcode — e.g. "Invalid
        // totp") is far more useful than axios's generic "Request
        // failed with status code 400", but only shows up in
        // err.response.data — surface it explicitly so Render logs
        // show the real reason, not just a status code.
        const detail = angelBody ? JSON.stringify(angelBody) : err.message;
        throw new Error(`ANGEL: login failed — ${detail}`);
      }
    }

    const data = loginRes.data?.data;
    if (!data?.jwtToken) throw new Error(`ANGEL: login failed, no jwtToken returned (${JSON.stringify(loginRes.data)})`);

    this.jwtToken = data.jwtToken;
    this.feedToken = data.feedToken;
    this.http.defaults.headers['Authorization'] = `Bearer ${this.jwtToken}`;
    this.http.defaults.headers['X-PrivateKey'] = this.apiKey;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(ANGEL_WS_URL, {
        headers: {
          Authorization: `Bearer ${this.jwtToken}`,
          'x-api-key': this.apiKey,
          'x-client-code': this.clientCode,
          'x-feed-token': this.feedToken
        }
      });
      let opened = false;

      this.ws.on('open', () => {
        opened = true;
        this._connectionStatus = 'CONNECTED';
        resolve(true);
      });

      this.ws.on('message', (data) => {
        try {
          this._handleFeedPacket(data);
        } catch (err) {
          this._emitError({ provider: 'ANGEL', stage: 'FEED_PARSE', error: err.message });
        }
      });

      this.ws.on('error', (err) => {
        this._connectionStatus = 'ERROR';
        this._emitError({ provider: 'ANGEL', stage: 'WS_ERROR', error: err.message });
        if (!opened) reject(err);
      });

      this.ws.on('close', (code, reasonBuf) => {
        this._connectionStatus = 'DISCONNECTED';
        // Same lesson learned from the Dhan adapter: a close with no
        // preceding 'error' event is common (server-side auth/session
        // rejection, idle timeout, etc). Without emitting here,
        // AdapterManager never finds out the connection died and
        // never retries — it just sits on DISCONNECTED forever. So:
        // always emit, unless WE closed it on purpose via disconnect().
        if (!this._intentionalDisconnect) {
          const reason = reasonBuf?.toString() || '(no reason given)';
          this._emitError({
            provider: 'ANGEL',
            stage: 'WS_CLOSE',
            error: `WebSocket closed unexpectedly — code ${code}, reason: ${reason}`
          });
        }
        if (!opened) reject(new Error(`ANGEL: WebSocket closed before opening (code ${code})`));
      });
    });
  }

  async disconnect() {
    this._intentionalDisconnect = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connectionStatus = 'DISCONNECTED';
  }

  async getQuote(instrument) {
    const { exchange, securityId, symbol } = instrument;
    const res = await this.http.post('/rest/secure/angelbroking/market/v1/quote/', {
      mode: 'FULL',
      exchangeTokens: { [exchange]: [String(securityId)] }
    });
    const raw = res.data?.data?.fetched?.[0];
    if (!raw) return null;
    return normalizeQuote({
      provider: 'ANGEL',
      symbol,
      exchange,
      segment: exchange,
      securityId,
      ltp: raw.ltp,
      ltq: raw.lastTradedQty,
      open: raw.open,
      high: raw.high,
      low: raw.low,
      close: raw.close,
      volume: raw.tradeVolume,
      totalBuyQuantity: raw.totBuyQuan,
      totalSellQuantity: raw.totSellQuan,
      oi: raw.opnInterest,
      dataQuality: 'EXACT'
    });
  }

  async getHistoricalCandles(instrument, timeframe) {
    const { exchange, securityId } = instrument;
    const res = await this.http.post('/rest/secure/angelbroking/historical/v1/getCandleData', {
      exchange,
      symboltoken: String(securityId),
      interval: mapTimeframeToAngelInterval(timeframe),
      fromdate: isoMinusDays(2),
      todate: isoNow()
    });
    const rows = res.data?.data || [];
    return rows.map((r) => ({
      timestamp: new Date(r[0]).getTime(),
      open: r[1],
      high: r[2],
      low: r[3],
      close: r[4],
      volume: r[5]
    }));
  }

  /**
   * Composes an option chain snapshot from Angel's instrument master
   * (for strike/token discovery) + the batch Quote API (for live
   * bid/ask/OI/LTP) — Angel has no single "option chain" endpoint
   * the way Dhan does, so this is built rather than fetched directly.
   * Returns the same shape DhanAdapter.getOptionChain() does, so
   * everything downstream (optionContractSelector, Wall/PCR engine)
   * works identically regardless of which broker is active.
   */
  async getOptionChain(symbol, expiryOverride) {
    const underlyingName = symbol;
    const expiry = expiryOverride && expiryOverride !== 'NEAREST_WEEKLY' ? expiryOverride : await getNearestExpiry(underlyingName);
    if (!expiry) return null;

    const chainTokens = await getOptionChainTokens(underlyingName, expiry);
    if (!chainTokens.length) return null;

    const indexToken = getIndexToken(underlyingName);
    const allTokens = [];
    if (indexToken) allTokens.push({ exchange: indexToken.exchange, token: indexToken.token });
    for (const row of chainTokens) {
      if (row.CE) allTokens.push({ exchange: row.CE.exchange, token: row.CE.token });
      if (row.PE) allTokens.push({ exchange: row.PE.exchange, token: row.PE.token });
    }

    const quotesByToken = await this._fetchQuotesBatched(allTokens);

    let spot = null;
    if (indexToken) {
      const q = quotesByToken.get(indexToken.token);
      spot = q?.ltp ?? null;
    }

    const strikes = chainTokens.map((row) => ({
      strike: row.strike,
      CE: row.CE ? this._quoteToLeg(quotesByToken.get(row.CE.token)) : null,
      PE: row.PE ? this._quoteToLeg(quotesByToken.get(row.PE.token)) : null
    }));

    return {
      provider: 'ANGEL',
      underlying: underlyingName,
      expiry,
      spot,
      strikes,
      dataQuality: 'COMPOSED' // built from master+quotes, not a single atomic broker snapshot like Dhan's — flagged so the frontend can show this honestly if it ever matters
    };
  }

  /** Angel's quote API caps at 50 symbols/request and 1 request/sec
   * (their own documented limit, raised from 10rps in 2024 in
   * exchange for the bulk-50 support) — chunk and pace accordingly
   * rather than risk a 429 mid-chain-fetch. */
  async _fetchQuotesBatched(tokens) {
    const results = new Map();
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 50) chunks.push(tokens.slice(i, i + 50));

    for (const chunk of chunks) {
      const byExchange = {};
      for (const { exchange, token } of chunk) {
        (byExchange[exchange] ||= []).push(token);
      }
      try {
        const res = await this.http.post('/rest/secure/angelbroking/market/v1/quote/', {
          mode: 'FULL',
          exchangeTokens: byExchange
        });
        const fetched = res.data?.data?.fetched || [];
        for (const q of fetched) {
          results.set(String(q.symbolToken), q);
        }
      } catch (err) {
        console.error('[AngelAdapter] Quote batch failed', err.response?.data || err.message);
      }
      if (chunks.length > 1) await new Promise((r) => setTimeout(r, 1100)); // stay under 1 rps
    }
    return results;
  }

  /**
   * Angel's FULL-mode quote response field names — verify against
   * https://smartapi.angelbroking.com/docs/MarketData if this ever
   * looks wrong; broker API response shapes do drift over time.
   */
  _quoteToLeg(q) {
    if (!q) return null;
    const bestBid = q.depth?.buy?.[0];
    const bestAsk = q.depth?.sell?.[0];
    return {
      ltp: q.ltp ?? null,
      bid: bestBid?.price ?? null,
      ask: bestAsk?.price ?? null,
      bidQty: bestBid?.quantity ?? null,
      askQty: bestAsk?.quantity ?? null,
      oi: q.opnInterest ?? q.openInterest ?? null,
      volume: q.tradeVolume ?? q.volume ?? null
    };
  }

  async subscribeMarketData(instruments) {
    this._sendSubscription(instruments, 3); // mode 3 = SnapQuote (includes best-5 depth)
    return true;
  }

  async unsubscribeMarketData(instruments) {
    this._sendSubscription(instruments, 3, true);
    return true;
  }

  async subscribeDepth(instruments) {
    // Angel's best depth is included in SnapQuote mode itself (best 5 only).
    this._sendSubscription(instruments, 3);
    return true;
  }

  async unsubscribeDepth(instruments) {
    this._sendSubscription(instruments, 3, true);
    return true;
  }

  _sendSubscription(instruments, mode, unsubscribe = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('ANGEL: cannot subscribe, socket not connected');
    }
    for (const inst of instruments) {
      this._subscribed.set(String(inst.securityId), { symbol: inst.symbol, exchange: inst.exchange });
    }
    const payload = {
      correlationID: `sub-${Date.now()}`,
      action: unsubscribe ? 0 : 1,
      params: {
        mode,
        tokenList: [
          {
            exchangeType: instruments[0]?.exchangeType ?? 1,
            tokens: instruments.map((i) => String(i.securityId))
          }
        ]
      }
    };
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Angel's binary tick format for SnapQuote mode. Verify field
   * offsets against current SmartAPI WebSocket docs before relying on
   * this — Angel documents exact offsets per subscription mode.
   */
  _handleFeedPacket(buffer) {
    if (!(buffer instanceof Buffer) || buffer.length < 51) return;

    const token = buffer.toString('utf8', 2, 27).replace(/\0/g, '');
    const meta = this._subscribed.get(token);
    const symbol = meta?.symbol || token;
    const exchange = meta?.exchange || 'UNKNOWN';

    const ltp = buffer.readInt32LE(43) / 100;
    const volume = buffer.readInt32LE(63) >= 0 ? buffer.readInt32LE(63) : null;

    this._emitQuote(
      normalizeQuote({
        provider: 'ANGEL',
        symbol,
        exchange,
        segment: exchange,
        securityId: token,
        ltp,
        volume,
        dataQuality: 'EXACT'
      })
    );

    // Best-5 depth, when present in the packet (SnapQuote mode only).
    if (buffer.length >= 379) {
      const bids = [];
      const asks = [];
      let offset = 147;
      for (let i = 0; i < 5; i++) {
        const qty = buffer.readInt32LE(offset);
        const price = buffer.readInt32LE(offset + 4) / 100;
        const orders = buffer.readInt16LE(offset + 8);
        const flag = buffer.readInt16LE(offset + 10); // 1 = buy, 0 = sell in Angel's layout
        const level = { price, quantity: qty, orderCount: orders, level: i + 1 };
        if (flag === 1) bids.push(level);
        else asks.push(level);
        offset += 12;
      }
      this._emitDepth(
        normalizeDepth({
          provider: 'ANGEL',
          symbol,
          securityId: token,
          levelsAvailable: Math.min(bids.length, asks.length),
          bids,
          asks,
          dataQuality: 'EXACT'
        })
      );
    }
  }
}

function mapTimeframeToAngelInterval(tf) {
  const map = { '1m': 'ONE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', '1h': 'ONE_HOUR', '1d': 'ONE_DAY' };
  return map[tf] || 'ONE_MINUTE';
}

function isoNow() {
  return formatAngelDate(new Date());
}
function isoMinusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return formatAngelDate(d);
}
function formatAngelDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


/**
 * Multi-URL Solana JSON-RPC WebSocket — failover, reconnect, `perMessageDeflate: false`.
 * Consommateur (ex. PumpScanner) envoie `logsSubscribe` sur l'événement `open`.
 */

import { EventEmitter } from 'events';
import WS from 'ws';

type WsMessagePayload = string | Buffer | ArrayBuffer | Buffer[];

export interface WebSocketPoolOptions {
  urls: string[];
  handshakeTimeoutMs?: number;
  reconnectDelayMs?: number;
}

export class WebSocketPool extends EventEmitter {
  private readonly urls: string[];
  private readonly handshakeTimeoutMs: number;
  private readonly reconnectDelayMs: number;

  private ws: WS | null = null;
  private activeIndex = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(opts: WebSocketPoolOptions) {
    super();
    this.urls = opts.urls.filter(Boolean);
    if (this.urls.length === 0) {
      throw new Error('WebSocketPool: at least one WS URL required');
    }
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 5_000;
  }

  get activeUrl(): string {
    return this.urls[this.activeIndex % this.urls.length]!;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** Arrêt immédiat (terminate). */
  stop(): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        /* cold path */
      }
      this.ws = null;
    }
  }

  /**
   * Envoie des frames JSON-RPC puis ferme (ex. `logsUnsubscribe`).
   */
  stopAfterSends(messages: string[]): void {
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.ws;
    this.ws = null;
    if (sock) {
      try {
        for (const m of messages) {
          try {
            sock.send(m);
          } catch {
            /* cold path */
          }
        }
      } finally {
        try {
          sock.terminate();
        } catch {
          /* cold path */
        }
      }
    }
  }

  send(data: string): void {
    try {
      this.ws?.send(data);
    } catch {
      /* cold path */
    }
  }

  private connect(): void {
    if (!this.started) return;

    const wsUrl = this.activeUrl;

    try {
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch {
          /* cold path */
        }
        this.ws = null;
      }

      this.ws = new WS(wsUrl, {
        perMessageDeflate: false,
        handshakeTimeout: this.handshakeTimeoutMs,
      });

      this.ws.on('open', () => {
        this.emit('open', wsUrl);
      });

      this.ws.on('message', (raw: WsMessagePayload) => {
        try {
          const msg = JSON.parse(raw.toString()) as unknown;
          this.emit('jsonrpc', msg);
        } catch {
          this.emit('rawError', new Error('jsonrpc parse'));
        }
      });

      this.ws.on('close', () => {
        this.emit('close', wsUrl);
        this.scheduleReconnect();
      });

      this.ws.on('error', (err: Error) => {
        this.emit('socketError', err);
      });
    } catch (err) {
      this.emit('connectError', err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started) return;
      this.activeIndex = (this.activeIndex + 1) % this.urls.length;
      this.emit('failover', this.activeIndex, this.activeUrl);
      this.connect();
    }, this.reconnectDelayMs);
  }

  /** Forcer bascule + reconnect (ex. health check silence). */
  forceRotateReconnect(): void {
    if (!this.started) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.terminate();
    } catch {
      /* cold path */
    }
    this.ws = null;
    this.activeIndex = (this.activeIndex + 1) % this.urls.length;
    this.emit('failover', this.activeIndex, this.activeUrl);
    this.connect();
  }
}

/** Parse `SOLANA_WS_URLS=a,b,c` ou retour vide pour fallback appelant. */
export function parseSolanaWsUrlsFromEnv(): string[] {
  const raw = (process.env.SOLANA_WS_URLS ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

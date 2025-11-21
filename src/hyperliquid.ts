import WebSocket from 'ws';
import fetch from 'node-fetch';
import { OrderBookSnapshot, AssetInfo, Meta } from './types';
import { config } from './config';

const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

export class HyperliquidClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, Set<(data: OrderBookSnapshot) => void>>();
  private tradeSubscriptions = new Map<string, Set<(data: any) => void>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isConnected = false;
  private assets: AssetInfo[] = [];
  private pingInterval: NodeJS.Timeout | null = null;
  private lastUpdateTime = new Map<string, number>();

  async initialize(): Promise<void> {
    await this.fetchAssets();
    await this.connect();
  }

  private async fetchAssets(): Promise<void> {
    try {
      const response = await fetch(HYPERLIQUID_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as Meta;
      this.assets = data.universe;
      console.log(`[Hyperliquid] Loaded ${this.assets.length} assets`);
    } catch (error) {
      console.error('[Hyperliquid] Failed to fetch assets:', error);
      throw error;
    }
  }

  getAssets(): AssetInfo[] {
    return this.assets;
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(HYPERLIQUID_WS_URL);

        this.ws.on('open', () => {
          console.log('[Hyperliquid] WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startPing();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message);
          } catch (error) {
            console.error('[Hyperliquid] Failed to parse message:', error);
          }
        });

        this.ws.on('pong', () => {
          // Сервер ответил на ping - соединение живое
          if (config.logLevel === 'debug') {
            console.log('[Hyperliquid] Pong received');
          }
        });

        this.ws.on('close', (code, reason) => {
          const reasonStr = reason.toString() || 'no reason provided';
          console.log(`[Hyperliquid] WebSocket disconnected: code=${code}, reason=${reasonStr}`);
          this.isConnected = false;
          this.stopPing();
          
          // Логируем код закрытия для диагностики
          if (code === 1006) {
            console.warn('[Hyperliquid] Abnormal closure (1006) - likely network timeout or server restart');
          } else if (code === 1000) {
            console.log('[Hyperliquid] Normal closure (1000)');
          } else if (code === 1001) {
            console.warn('[Hyperliquid] Going away (1001) - server shutting down');
          } else if (code === 1002) {
            console.error('[Hyperliquid] Protocol error (1002)');
          } else if (code === 1003) {
            console.error('[Hyperliquid] Unsupported data (1003)');
          }
          
          this.handleReconnect();
        });

        this.ws.on('error', (error: any) => {
          // Логируем ошибку с деталями
          const errorMsg = error.message || 'Unknown error';
          const errorCode = error.code || 'NO_CODE';
          
          console.error(`[Hyperliquid] WebSocket error: ${errorMsg} (code: ${errorCode})`);
          
          // Специальная обработка для WS_ERR_INVALID_CLOSE_CODE
          if (errorCode === 'WS_ERR_INVALID_CLOSE_CODE') {
            console.warn('[Hyperliquid] Invalid close code - это нормально при network timeout, reconnect...');
          }
          
          if (!this.isConnected) {
            reject(error);
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Hyperliquid] Max reconnection attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s...
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1), 60000); // max 60s

    console.log(
      `[Hyperliquid] Reconnecting in ${(delay / 1000).toFixed(1)}s ` +
      `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(async () => {
      try {
        console.log('[Hyperliquid] Attempting to reconnect...');
        await this.connect();
        console.log(`[Hyperliquid] Reconnected successfully! Restoring ${this.subscriptions.size} subscriptions...`);
        this.resubscribeAll();
      } catch (error) {
        console.error('[Hyperliquid] Reconnection failed:', error);
        // handleReconnect вызовется автоматически из on('close')
      }
    }, delay);
  }

  private handleMessage(message: any): void {
    if (message.channel === 'l2Book' && message.data) {
      const snapshot: OrderBookSnapshot = {
        coin: message.data.coin,
        time: message.data.time,
        levels: message.data.levels,
      };

      // Отслеживаем частоту обновлений для дебага
      const now = Date.now();
      const lastUpdate = this.lastUpdateTime.get(snapshot.coin);
      if (lastUpdate && config.logLevel === 'debug') {
        const delta = now - lastUpdate;
        if (delta > 1000) {
          // Логируем только если задержка > 1 сек (необычно) и в debug режиме
          console.warn(`[Hyperliquid] Large update gap for ${snapshot.coin}: ${delta}ms`);
        }
      }
      this.lastUpdateTime.set(snapshot.coin, now);

      const callbacks = this.subscriptions.get(snapshot.coin);
      if (callbacks) {
        callbacks.forEach((callback) => callback(snapshot));
      }
    }

    if (message.channel === 'trades' && message.data) {
      const callbacks = this.tradeSubscriptions.get(message.data.coin);
      if (callbacks) {
        callbacks.forEach((callback) => callback(message.data));
      }
    }
  }

  subscribeToOrderBook(coin: string, callback: (data: OrderBookSnapshot) => void): void {
    if (!this.subscriptions.has(coin)) {
      this.subscriptions.set(coin, new Set());
    }

    this.subscriptions.get(coin)!.add(callback);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendSubscription(coin);
    }
  }

  private sendSubscription(coin: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const subscription = {
      method: 'subscribe',
      subscription: {
        type: 'l2Book',
        coin: coin,
      },
    };

    this.ws.send(JSON.stringify(subscription));
    console.log(`[Hyperliquid] Subscribed to ${coin} orderbook`);
  }

  private resubscribeAll(): void {
    console.log(`[Hyperliquid] Resubscribing to ${this.subscriptions.size} orderbooks`);
    for (const coin of this.subscriptions.keys()) {
      this.sendSubscription(coin);
    }
  }

  subscribeToAllAssets(callback: (data: OrderBookSnapshot) => void): void {
    console.log(`[Hyperliquid] Subscribing to ${this.assets.length} assets`);
    for (const asset of this.assets) {
      this.subscribeToOrderBook(asset.name, callback);
    }
  }

  /**
   * Подписка на сделки (trades) для конкретной монеты.
   * Сделки приходят моментально и показывают реальное съедание заявок.
   */
  subscribeToTrades(coin: string, callback: (data: any) => void): void {
    if (!this.tradeSubscriptions.has(coin)) {
      this.tradeSubscriptions.set(coin, new Set());

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const subscription = {
          method: 'subscribe',
          subscription: {
            type: 'trades',
            coin: coin,
          },
        };
        this.ws.send(JSON.stringify(subscription));
        console.log(`[Hyperliquid] Subscribed to ${coin} trades`);
      }
    }

    this.tradeSubscriptions.get(coin)!.add(callback);
  }

  /**
   * Получить время с последнего обновления для монеты (для дебага).
   */
  getTimeSinceLastUpdate(coin: string): number | null {
    const lastUpdate = this.lastUpdateTime.get(coin);
    if (!lastUpdate) return null;
    return Date.now() - lastUpdate;
  }

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}


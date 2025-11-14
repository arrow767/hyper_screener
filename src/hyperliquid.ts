import WebSocket from 'ws';
import fetch from 'node-fetch';
import { OrderBookSnapshot, AssetInfo, Meta } from './types';

const HYPERLIQUID_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';

export class HyperliquidClient {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, Set<(data: OrderBookSnapshot) => void>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isConnected = false;
  private assets: AssetInfo[] = [];
  private pingInterval: NodeJS.Timeout | null = null;

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

        this.ws.on('close', () => {
          console.log('[Hyperliquid] WebSocket disconnected');
          this.isConnected = false;
          this.stopPing();
          this.handleReconnect();
        });

        this.ws.on('error', (error) => {
          console.error('[Hyperliquid] WebSocket error:', error);
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
      console.error('[Hyperliquid] Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(
      `[Hyperliquid] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`
    );

    setTimeout(async () => {
      try {
        await this.connect();
        this.resubscribeAll();
      } catch (error) {
        console.error('[Hyperliquid] Reconnection failed:', error);
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

      const callbacks = this.subscriptions.get(snapshot.coin);
      if (callbacks) {
        callbacks.forEach((callback) => callback(snapshot));
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

  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}


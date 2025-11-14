import { OrderBookSnapshot, LargeOrder } from './types';
import { config } from './config';
import { HyperliquidClient } from './hyperliquid';
import { TelegramNotifier } from './telegram';
import fetch from 'node-fetch';

interface MarkPrice {
  [coin: string]: number;
}

export class OrderBookMonitor {
  private hyperliquid: HyperliquidClient;
  private telegram: TelegramNotifier;
  private markPrices: MarkPrice = {};
  private priceUpdateInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.hyperliquid = new HyperliquidClient();
    this.telegram = new TelegramNotifier();
  }

  async start(): Promise<void> {
    console.log('[Monitor] Starting orderbook monitor...');
    console.log(`[Monitor] Min order size: $${config.minOrderSizeUsd.toLocaleString()}`);
    console.log(`[Monitor] Max distance: ${config.maxDistancePercent}%`);

    await this.telegram.initialize();
    await this.hyperliquid.initialize();

    this.hyperliquid.subscribeToAllAssets((snapshot) => {
      this.processOrderBook(snapshot);
    });

    console.log('[Monitor] Monitor started successfully');

    setInterval(() => {
      this.telegram.cleanup();
    }, 3600000);
  }

  private async updateMarkPrices(): Promise<void> {
    try {
      const response = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = (await response.json()) as { [coin: string]: string };
      
      for (const [coin, price] of Object.entries(data)) {
        this.markPrices[coin] = parseFloat(price);
      }

      if (config.logLevel === 'debug') {
        console.log(`[Monitor] Updated mark prices for ${Object.keys(this.markPrices).length} coins`);
      }
    } catch (error) {
      console.error('[Monitor] Failed to update mark prices:', error);
    }
  }

  private startPriceUpdates(): void {
    this.priceUpdateInterval = setInterval(() => {
      this.updateMarkPrices();
    }, 5000);
  }

  private processOrderBook(snapshot: OrderBookSnapshot): void {
    const [rawBids, rawAsks] = snapshot.levels as unknown as [any[], any[]];

    if (!rawBids.length || !rawAsks.length) {
      return;
    }

    const bestBid = this.extractPriceSize(rawBids[0]);
    const bestAsk = this.extractPriceSize(rawAsks[0]);

    if (!bestBid || !bestAsk) {
      return;
    }

    const markPrice = (bestBid.price + bestAsk.price) / 2;

    if (!isFinite(markPrice) || markPrice <= 0) {
      return;
    }

    for (const level of rawBids) {
      const parsed = this.extractPriceSize(level);
      if (!parsed) continue;
      this.checkOrder(snapshot.coin, 'bid', parsed.price, parsed.size, markPrice);
    }

    for (const level of rawAsks) {
      const parsed = this.extractPriceSize(level);
      if (!parsed) continue;
      this.checkOrder(snapshot.coin, 'ask', parsed.price, parsed.size, markPrice);
    }
  }

  private extractPriceSize(level: any): { price: number; size: number } | null {
    if (!level) return null;

    let priceRaw: any;
    let sizeRaw: any;

    if (Array.isArray(level)) {
      // Возможный формат: [price, size, ...]
      [priceRaw, sizeRaw] = level;
    } else if (typeof level === 'object') {
      // Возможные ключи: price/size или px/sz
      priceRaw = (level as any).price ?? (level as any).px;
      sizeRaw = (level as any).size ?? (level as any).sz;
    } else {
      return null;
    }

    const price = parseFloat(String(priceRaw));
    const size = parseFloat(String(sizeRaw));

    if (!isFinite(price) || !isFinite(size) || price <= 0 || size <= 0) {
      return null;
    }

    return { price, size };
  }

  private checkOrder(
    coin: string,
    side: 'bid' | 'ask',
    price: number,
    size: number,
    markPrice: number
  ): void {
    const valueUsd = price * size;

    const perCoinOverride = config.perCoinMinOrderSizeUsd[coin.toUpperCase()];
    const effectiveMinOrderSizeUsd = perCoinOverride ?? config.minOrderSizeUsd;

    if (valueUsd < effectiveMinOrderSizeUsd) {
      return;
    }

    const distancePercent = side === 'bid'
      ? ((markPrice - price) / markPrice) * 100
      : ((price - markPrice) / markPrice) * 100;

    if (distancePercent < 0 || distancePercent > config.maxDistancePercent) {
      return;
    }

    const largeOrder: LargeOrder = {
      coin,
      side,
      price,
      size,
      valueUsd,
      distancePercent,
      timestamp: Date.now(),
    };

    if (config.logLevel === 'debug') {
      console.log(
        `[Monitor] Large order found: ${coin} ${side.toUpperCase()} @ $${price} | ` +
        `Size: $${valueUsd.toFixed(0)} | Distance: ${distancePercent.toFixed(3)}%`
      );
    }

    this.telegram.sendAlert(largeOrder);
  }

  stop(): void {
    console.log('[Monitor] Stopping monitor...');
    
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }

    this.hyperliquid.disconnect();
    console.log('[Monitor] Monitor stopped');
  }
}


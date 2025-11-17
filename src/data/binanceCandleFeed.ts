import fetch from 'node-fetch';
import { NatrService, Candle } from '../indicators/natr';
import { config } from '../config';

const DEFAULT_BASE_URL = 'https://fapi.binance.com';

/**
 * Простая подача 5m свечей Binance Futures → NatrService.
 * Работает только по тем монетам, которые явно добавлены через trackCoin.
 */
export class BinanceCandleFeed {
  private readonly natrService: NatrService;
  private readonly baseUrl: string;
  private readonly trackedCoins = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(natrService: NatrService) {
    this.natrService = natrService;
    this.baseUrl = process.env.BINANCE_FUTURES_BASE_URL || DEFAULT_BASE_URL;
  }

  trackCoin(coin: string): void {
    this.trackedCoins.add(coin.toUpperCase());
  }

  start(): void {
    if (this.timer) return;
    // 20 секунд — достаточно редко, чтобы не упереться в лимиты, но достаточно часто для NATR
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[BinanceCandleFeed] tick error:', err);
      });
    }, 20_000);
    console.log('[BinanceCandleFeed] Started 5m candle feed for NATR');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (!this.trackedCoins.size) return;

    for (const coin of this.trackedCoins) {
      try {
        await this.fetchLastCandleForCoin(coin);
      } catch (error) {
        if (config.logLevel === 'debug') {
          console.error(`[BinanceCandleFeed] Failed to fetch candle for ${coin}:`, error);
        }
      }
    }
  }

  private async fetchLastCandleForCoin(coin: string): Promise<void> {
    const symbol = `${coin.toUpperCase()}USDT`;
    const url = `${this.baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=5m&limit=1`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as any[];
    if (!Array.isArray(data) || !data.length) return;

    const k = data[0];
    // Формат Binance kline:
    // [ openTime, open, high, low, close, volume, closeTime, ... ]
    const candle: Candle = {
      timestamp: Number(k[0]),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
    };

    const natr = this.natrService.update(coin, candle);
    if (config.logLevel === 'debug' && natr != null) {
      console.log(`[BinanceCandleFeed] NATR updated for ${coin}: ${natr.toFixed(4)}%`);
    }
  }
}



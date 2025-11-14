export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  minOrderSizeUsd: number;
  maxDistancePercent: number;
  alertCooldownMs: number;
  logLevel: string;
  /**
   * Кастомные минимальные размеры заявок по монетам, например:
   * { BTC: 5000000, ETH: 3000000 }
   */
  perCoinMinOrderSizeUsd: Record<string, number>;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBookSnapshot {
  coin: string;
  time: number;
  levels: [OrderBookLevel[], OrderBookLevel[]];
}

export interface LargeOrder {
  coin: string;
  side: 'bid' | 'ask';
  price: number;
  size: number;
  valueUsd: number;
  distancePercent: number;
  timestamp: number;
}

export interface AssetInfo {
  name: string;
  szDecimals: number;
}

export interface Meta {
  universe: AssetInfo[];
}


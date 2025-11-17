export type TradeMode = 'SCREEN_ONLY' | 'TRADE_PAPER' | 'TRADE_LIVE';
export type TradeExecutionVenue = 'PAPER' | 'HYPERLIQUID' | 'BINANCE';

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

  // --- Trading config (Спринт 1, только конфигурация, без реализации логики) ---
  tradeEnabled: boolean;
  tradeMode: TradeMode;
  tradePositionSizeUsd: number;
  tradeMaxRiskPerTrade: number;
  tradeMaxOpenPositions: number;
  tradeNatrPeriod: number;
  /**
   * Таймфрейм для NATR, например '5m'
   */
  tradeNatrTimeframe: string;
  /**
   * Диапазон входа в NATR, например [1, 2]
   */
  tradeEntryNatrRange: [number, number];
  /**
   * Уровни тейков в NATR, например [2, 3]
   */
  tradeTpNatrLevels: number[];
  /**
   * Проценты позиции по уровням тейков, например [50, 50]
   */
  tradeTpPercents: number[];
  /**
   * Смещение SL в тиках за плотностью
   */
  tradeSlTickOffset: number;
  /**
   * Доля остатка плотности (0–1), при которой закрываем позицию по "разъеданию".
   * Например, 0.3 = 30% от исходного объёма.
   */
  tradeAnchorMinValueFraction: number;
  /**
   * Минимальный абсолютный остаток плотности в USD, ниже которого закрываем позицию.
   */
  tradeAnchorMinValueUsd: number;
  /**
   * Максимальный дневной убыток для торгового модуля (USD)
   */
  tradeDailyMaxLoss: number;
  /**
   * Максимальное количество сделок в день
   */
  tradeDailyMaxTrades: number;
  /**
   * Где исполняем ордера: эмуляция (PAPER), Hyperliquid или Binance.
   * На текущем этапе реализован только PAPER, остальные режимы — заглушки.
   */
  tradeExecutionVenue: TradeExecutionVenue;
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
  /**
   * Размер тика цены (если доступен в meta Hyperliquid).
   * Поле опциональное, так как формат meta может отличаться.
   */
  tickSize?: number;
}

export interface Meta {
  universe: AssetInfo[];
}


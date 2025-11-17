export type TradeMode = 'SCREEN_ONLY' | 'TRADE_PAPER' | 'TRADE_LIVE';
export type TradeExecutionVenue = 'PAPER' | 'HYPERLIQUID' | 'BINANCE';
export type TradeEntryMode = 'MARKET' | 'LIMIT' | 'MIXED';

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
  /**
   * Максимальный риск на сделку в USD. Если > 0, размер позиции рассчитывается динамически.
   */
  tradeMaxRiskPerTrade: number;
  /**
   * Множитель NATR для расчёта риска (сколько NATR использовать как расстояние до SL).
   * Используется для динамического расчёта размера позиции.
   */
  tradeRiskNatrMultiplier: number;
  /**
   * Интервал проверки PnL в миллисекундах (по умолчанию 4000 = 4 секунды).
   * Используется только при TRADE_MAX_RISK_PER_TRADE > 0.
   */
  tradeRiskPnlCheckIntervalMs: number;
  tradeMaxOpenPositions: number;
  
  // --- Trade logging configuration ---
  /**
   * Включить логирование сделок в CSV файл.
   */
  tradeLogEnabled: boolean;
  /**
   * Директория для сохранения CSV логов сделок.
   */
  tradeLogDir: string;
  
  // --- Listing monitor configuration ---
  /**
   * Включить мониторинг новых листингов на Hyperliquid.
   */
  listingMonitorEnabled: boolean;
  /**
   * Отправлять уведомления о новых листингах в Telegram.
   */
  listingNotifyTelegram: boolean;
  /**
   * Интервал проверки новых листингов в миллисекундах (по умолчанию 60000 = 1 минута).
   */
  listingCheckIntervalMs: number;
  /**
   * Путь к файлу истории листингов.
   */
  listingHistoryFile: string;
  
  // --- Position policy configuration (Спринт 9) ---
  /**
   * Включить систему контекстных правил (policy engine).
   */
  policyEnabled: boolean;
  /**
   * Путь к YAML файлу с правилами policy (контекстные правила).
   */
  policyRulesFile: string;
  /**
   * Путь к файлу с памятью якорей (anchor memory).
   * Хранит статистику по каждому якорю (coin, price, side).
   */
  policyAnchorMemoryFile: string;
  /**
   * Минимальное время жизни заявки в миллисекундах (анти-спуфинг).
   * Если заявка появилась менее чем X мс назад, торговля игнорируется.
   * Защита от спуферов, которые быстро снимают заявки.
   */
  tradeMinOrderLifetimeMs: number;
  
  tradeNatrPeriod: number;
  /**
   * Таймфрейм для NATR, например '5m'
   */
  tradeNatrTimeframe: string;
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

  // --- Entry Mode Configuration (MARKET / LIMIT / MIXED) ---
  /**
   * Режим входа в позицию: MARKET - только рыночные ордера, LIMIT - только лимитные, MIXED - комбо.
   */
  tradeEntryMode: TradeEntryMode;
  /**
   * Процент позиции для рыночного входа (для MIXED режима), например 50 = 50%.
   */
  tradeEntryMarketPercent: number;
  /**
   * Процент позиции для лимитного входа (для MIXED режима), например 50 = 50%.
   */
  tradeEntryLimitPercent: number;

  // --- Limit Order Placement Configuration ---
  /**
   * Диапазон в NATR от цены плотности для размещения лимитных ордеров, например [-0.2, 0.4].
   * Отрицательные значения = за плотностью (для лонга - ниже, для шорта - выше).
   * Положительные значения = перед плотностью (для лонга - выше, для шорта - ниже).
   */
  tradeEntryLimitNatrRange: [number, number];
  /**
   * Пропорции лимитных ордеров на вход, например [50, 50] или [25, 25, 25, 25].
   */
  tradeEntryLimitProportions: number[];
  /**
   * Порог деградации плотности (в % от начальной), при котором снимаем лимитные ордера, например 50 = 50%.
   */
  tradeEntryLimitDensityMinPercent: number;

  // --- Take Profit Limit Order Configuration ---
  /**
   * Пропорции лимитных ордеров на выход (TP), например [50, 50] или [33, 33, 34].
   */
  tradeTpLimitProportions: number[];
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


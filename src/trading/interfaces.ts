import { LargeOrder, TradeMode, OrderBookSnapshot } from '../types';

/**
 * Сигнал на вход от скринера плотностей/роботов/арбитража.
 * На этом этапе это только интерфейс, без реализации.
 */
export interface TradeSignal {
  coin: string;
  side: 'long' | 'short';
  /**
   * Референсная цена входа (например, цена крупной лимитки или текущая рыночная).
   */
  referencePrice: number;
  /**
   * Желаемый размер позиции в USD (после риск-менеджмента может быть скорректирован).
   */
  targetPositionSizeUsd: number;
  /**
   * Исходный объект крупного ордера (если есть), полезен для SL/TP логики.
   */
  sourceLargeOrder?: LargeOrder;
  /**
   * Источник сигнала: 'liquidity', 'robot', 'arbitrage', ...
   */
  source: 'liquidity' | 'robot' | 'arbitrage';
  /**
   * Дополнительные параметры, специфичные для стратегии.
   */
  meta?: Record<string, unknown>;
}

/**
 * Информация о текущем режиме и лимитах торговли.
 */
export interface TradingContext {
  mode: TradeMode;
  /**
   * Общие лимиты риска и параметров стратегии (снято из config, но в удобной форме).
   */
  maxOpenPositions: number;
  dailyMaxLoss: number;
  dailyMaxTrades: number;
}

/**
 * Информация об активном лимитном ордере (на вход или на выход).
 */
export interface LimitOrderState {
  orderId: string;
  coin: string;
  price: number;
  sizeUsd: number;
  contracts?: number; // Размер в контрактах (лотах) биржи
  side: 'buy' | 'sell';
  purpose: 'entry' | 'tp';
  placedAt: number;
  filled?: boolean;
  filledAt?: number;
  cancelled?: boolean;
  cancelledAt?: number;
}

/**
 * Базовое описание открытой позиции для торгового модуля.
 */
export interface PositionState {
  id: string;
  coin: string;
  side: 'long' | 'short';
  entryPrice: number;
  sizeUsd: number; // Текущий размер позиции (уменьшается при частичном закрытии)
  sizeContracts?: number; // Размер позиции в контрактах (лотах) биржи
  initialSizeUsd?: number; // Начальный полный размер позиции (для расчета TP)
  initialSizeContracts?: number; // Начальный размер в контрактах (для расчета TP без пыли)
  openedAt: number;
  /**
   * Сторона исходной плотности (bid/ask), от которой заходили.
   */
  anchorSide?: 'bid' | 'ask';
  /**
   * Цена крупной лимитной заявки, от которой заходили.
   */
  anchorPrice?: number;
  /**
   * Исходный объём крупной заявки в USD.
   */
  anchorInitialValueUsd?: number;
  /**
   * Пороговый объём заявки в USD, ниже которого выходим (например, 30% или фиксированный минимум).
   */
  anchorMinValueUsd?: number;
  /**
   * Цели тейк-профита по NATR (лесенка).
   */
  tpTargets?: {
    price: number;
    sizeUsd: number;
    hit: boolean;
  }[];
  /**
   * Активные лимитные ордера на вход (для режима LIMIT или MIXED).
   */
  entryLimitOrders?: LimitOrderState[];
  /**
   * Активные лимитные ордера на выход (TP лимитками).
   */
  tpLimitOrders?: LimitOrderState[];
  /**
   * Сохраненные цены TP уровней (чтобы не пересчитывать при изменении объема).
   * Ключ: индекс уровня (0, 1, 2...), значение: цена.
   */
  tpPriceCache?: Map<number, number>;
  /**
   * NATR на момент размещения TP (чтобы не пересчитывать при изменении NATR).
   */
  tpNatrSnapshot?: number;
  /**
   * Размер позиции, уже заполненный через рыночные ордера (USD).
   */
  marketFilledSizeUsd?: number;
  /**
   * Размер позиции, уже заполненный через лимитные ордера (USD).
   */
  limitFilledSizeUsd?: number;
  /**
   * Реальные trades от биржи при открытии позиции (для точного расчета PnL).
   */
  entryTrades?: BinanceTrade[];
  /**
   * Реальные trades от биржи при закрытии позиции (для точного расчета PnL).
   */
  exitTrades?: BinanceTrade[];
}

/**
 * Trade (исполнение) от Binance Futures API.
 */
export interface BinanceTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: 'BUY' | 'SELL';
  price: string;
  qty: string;
  realizedPnl: string;
  marginAsset: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  positionSide: string;
  buyer: boolean;
  maker: boolean;
}

/**
 * Модуль риск-менеджмента.
 * На этом этапе описываем только интерфейс, без реализации.
 */
export interface RiskManager {
  /**
   * Проверка, можно ли открывать новую позицию по данному сигналу
   * с учётом текущих позиций и дневных лимитов.
   */
  canOpenPosition(signal: TradeSignal, context: TradingContext, openPositions: PositionState[]): boolean;
}

/**
 * ExecutionEngine отвечает только за взаимодействие с биржей/биржами.
 * Интерфейс описывает, какие операции нужны торговому модулю.
 */
export interface ExecutionEngine {
  /**
   * Открыть позицию (лимитом или маркетом — конкретное поведение будет задаваться стратегией).
   */
  openPosition(signal: TradeSignal): Promise<PositionState | null>;

  /**
   * Закрыть позицию полностью (по рынку или лимитом — детали в реализации).
   */
  closePosition(position: PositionState, reason: string): Promise<void>;

  /**
   * Разместить лимитный ордер на вход или выход.
   * @param contracts - Опционально: точное количество контрактов (для TP без пыли)
   */
  placeLimitOrder(
    coin: string,
    side: 'buy' | 'sell',
    price: number,
    sizeUsd: number,
    purpose: 'entry' | 'tp',
    contracts?: number
  ): Promise<LimitOrderState | null>;

  /**
   * Отменить лимитный ордер.
   */
  cancelLimitOrder(order: LimitOrderState): Promise<void>;

  /**
   * Получить статус лимитного ордера (заполнен ли).
   */
  checkLimitOrderStatus?(order: LimitOrderState): Promise<{ filled: boolean; filledSize?: number }>;

  /**
   * Синхронизация открытых позиций с биржей (read-only).
   * Базовая реализация: просто логируем существующие позиции и игнорируем их.
   */
  syncOpenPositions?(): Promise<void>;

  /**
   * Получить актуальную позицию в контрактах (лотах) для конкретного символа.
   * Возвращает { contracts, sizeUsd, entryPrice } или null если позиции нет.
   */
  getPositionContracts?(coin: string): Promise<{ contracts: number; sizeUsd: number; entryPrice: number } | null>;

  /**
   * Получить текущие позиции с биржи с реализованным PnL.
   * Используется для периодического мониторинга убытков.
   */
  getCurrentPositions?(): Promise<Array<{
    coin: string;
    side: 'long' | 'short';
    entryPrice: number;
    currentPrice: number;
    sizeUsd: number;
    pnlUsd: number;
  }>>;
}

/**
 * Высокоуровневый торговый модуль, который будет подписан на сигналы скринера.
 * На этом шаге реализуем только интерфейс.
 */
export interface TradingModule {
  readonly mode: TradeMode;

  /**
   * Обработка сигнала от скринера (например, крупная лимитка).
   */
  handleSignal(signal: TradeSignal): Promise<void>;

  /**
   * Обработка крупной лимитной заявки напрямую (для bounce-логики от плотностей).
   */
  onLargeOrder(order: LargeOrder): Promise<void>;

  /**
   * Обработка снэпшота стакана (для отслеживания разъедания/снятия плотностей и SL/TP).
   * Реализуется по желанию конкретным модулем.
   */
  onOrderBookSnapshot?(snapshot: OrderBookSnapshot): Promise<void>;

  /**
   * Корректное завершение работы (отмена активных задач, сохранение состояния и т.п.).
   */
  shutdown(): Promise<void>;
}



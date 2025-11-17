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
 * Базовое описание открытой позиции для торгового модуля.
 */
export interface PositionState {
  id: string;
  coin: string;
  side: 'long' | 'short';
  entryPrice: number;
  sizeUsd: number;
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
   * Синхронизация открытых позиций с биржей (read-only).
   * Базовая реализация: просто логируем существующие позиции и игнорируем их.
   */
  syncOpenPositions?(): Promise<void>;
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
  onOrderBookSnapshot?(snapshot: OrderBookSnapshot): Promise<void> | void;

  /**
   * Корректное завершение работы (отмена активных задач, сохранение состояния и т.п.).
   */
  shutdown(): Promise<void>;
}



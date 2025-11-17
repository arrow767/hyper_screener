import { config } from '../config';
import { LargeOrder, OrderBookSnapshot } from '../types';
import { NatrService } from '../indicators/natr';
import { BinanceCandleFeed } from '../data/binanceCandleFeed';
import {
  ExecutionEngine,
  LimitOrderState,
  PositionState,
  RiskManager,
  TradeSignal,
  TradingContext,
  TradingModule,
} from './interfaces';
import { TradeLogger } from './tradeLogger';
import { ContextFeaturesService, ContextFeatures } from './contextFeatures';
import { AnchorMemory, AnchorId, AnchorStats } from './anchorMemory';
import { PositionPolicy, PolicyDecision } from './positionPolicy';

class BasicRiskManager implements RiskManager {
  canOpenPosition(signal: TradeSignal, context: TradingContext, openPositions: PositionState[]): boolean {
    // 1. Ограничение по общему количеству позиций
    if (openPositions.length >= context.maxOpenPositions) {
      if (config.logLevel === 'debug') {
        console.log(
          `[Risk] maxOpenPositions reached (${openPositions.length}/${context.maxOpenPositions}), skip new position`
        );
      }
      return false;
    }

    // 2. Уже открыта позиция по этой монете — не лезем снова (простое правило)
    const hasPositionForCoin = openPositions.some((p) => p.coin === signal.coin);
    if (hasPositionForCoin) {
      if (config.logLevel === 'debug') {
        console.log(`[Risk] position for ${signal.coin} already exists, skip new position`);
      }
      return false;
    }

    // 3. Лимиты по дневному убытку/кол-ву сделок будут добавлены позже
    return true;
  }
}

/**
 * BounceTradingModule — модуль, который реагирует на крупные лимитные заявки,
 * конвертирует их в сигналы и отдаёт в ExecutionEngine.
 *
 * В данной версии:
 * - работает только с PaperExecutionEngine (эмуляция);
 * - не использует NATR/TP/SL, только базовая логика входа/выхода будет добавляться по шагам.
 */
export class BounceTradingModule implements TradingModule {
  readonly mode = config.tradeMode;

  private readonly engine: ExecutionEngine;
  private readonly riskManager: RiskManager;
  private readonly context: TradingContext;
  private readonly openPositions: PositionState[] = [];
  private readonly natrService?: NatrService;
  private readonly candleFeed?: BinanceCandleFeed;
  private readonly hyperliquid?: any; // HyperliquidClient для подписки на trades
  /**
   * Защита от конкурирующих входов: пока по монете есть in-flight openPosition, не открываем новую.
   */
  private readonly pendingCoins = new Set<string>();
  /**
   * Последнее залогированное значение плотности для каждой позиции (для уменьшения спама в логах).
   */
  private readonly lastLoggedDensity = new Map<string, { percent: number; time: number }>();
  /**
   * Интервал для периодической проверки PnL (каждые 4 секунды).
   */
  private pnlCheckInterval?: NodeJS.Timeout;
  /**
   * Кэш последних цен для расчёта PnL.
   */
  private readonly lastPrices = new Map<string, number>();
  /**
   * Логгер для записи сделок в CSV.
   */
  private readonly tradeLogger: TradeLogger;
  /**
   * Сервис для расчёта контекстных фичей (Спринт 9).
   */
  private readonly contextFeatures?: ContextFeaturesService;
  /**
   * Память по якорям для отслеживания статистики (Спринт 9).
   */
  private readonly anchorMemory?: AnchorMemory;
  /**
   * Движок правил для адаптации размера/TP/SL (Спринт 9).
   */
  private readonly positionPolicy?: PositionPolicy;

  constructor(engine: ExecutionEngine, natrService?: NatrService, candleFeed?: BinanceCandleFeed, riskManager?: RiskManager, hyperliquid?: any) {
    this.engine = engine;
    this.natrService = natrService;
    this.candleFeed = candleFeed;
    this.hyperliquid = hyperliquid;
    this.riskManager = riskManager ?? new BasicRiskManager();
    this.tradeLogger = new TradeLogger(config.tradeLogDir, config.tradeLogEnabled);
    
    // Инициализация модулей Спринта 9 (если включены)
    if (config.policyEnabled) {
      this.contextFeatures = new ContextFeaturesService();
      this.anchorMemory = new AnchorMemory(config.policyAnchorMemoryFile, true);
      this.positionPolicy = new PositionPolicy();
      console.log('[Trading] Policy engine включён (Спринт 9)');
    }
    this.context = {
      mode: config.tradeMode,
      maxOpenPositions: config.tradeMaxOpenPositions,
      dailyMaxLoss: config.tradeDailyMaxLoss,
      dailyMaxTrades: config.tradeDailyMaxTrades,
    };

    console.log(
      `[Trading] BounceTradingModule инициализирован в режиме ${this.context.mode}, ` +
        `executionVenue=${config.tradeExecutionVenue}, tradeEnabled=${config.tradeEnabled}, ` +
        `entryMode=${config.tradeEntryMode}`
    );

    // Запускаем периодический мониторинг PnL, если включен динамический риск
    if (config.tradeMaxRiskPerTrade > 0) {
      this.startPnlMonitoring();
    }
  }

  /**
   * Запуск периодического мониторинга PnL для защиты от больших убытков.
   */
  private startPnlMonitoring(): void {
    const intervalMs = config.tradeRiskPnlCheckIntervalMs;
    console.log(
      `[Trading] Запущен PnL-мониторинг с интервалом ${intervalMs}ms (${(intervalMs / 1000).toFixed(1)}s), ` +
      `maxRisk=${config.tradeMaxRiskPerTrade}$`
    );
    
    this.pnlCheckInterval = setInterval(() => {
      this.checkPnlAndEmergencyClose().catch((err) => {
        console.error('[Trading] Ошибка при проверке PnL:', err);
      });
    }, intervalMs);
  }

  /**
   * Проверка PnL всех открытых позиций и экстренное закрытие при превышении риска.
   */
  private async checkPnlAndEmergencyClose(): Promise<void> {
    if (this.openPositions.length === 0) {
      return;
    }

    const now = Date.now();
    for (const position of this.openPositions) {
      const currentPrice = this.lastPrices.get(position.coin);
      if (!currentPrice) {
        continue; // Нет данных по цене, пропускаем
      }

      // Расчёт PnL в USD
      const priceDiff = position.side === 'long' 
        ? currentPrice - position.entryPrice 
        : position.entryPrice - currentPrice;
      const pnlPercent = (priceDiff / position.entryPrice) * 100;
      const pnlUsd = (position.sizeUsd * pnlPercent) / 100;

      // Проверяем, превышен ли максимальный риск (убыток)
      if (pnlUsd < -config.tradeMaxRiskPerTrade) {
        const holdTimeSeconds = Math.round((now - position.openedAt) / 1000);
        console.warn(
          `[Trading] ⚠️ ЭКСТРЕННОЕ ЗАКРЫТИЕ: ${position.coin} ${position.side.toUpperCase()} ` +
          `PnL=${pnlUsd.toFixed(2)}$ (${pnlPercent.toFixed(2)}%) превысил maxRisk=${config.tradeMaxRiskPerTrade}$ ` +
          `(entry=${position.entryPrice.toFixed(4)}, current=${currentPrice.toFixed(4)}, held=${holdTimeSeconds}s)`
        );

        // 1. Отменяем все лимитные ордера на этом инструменте
        await this.cancelAllLimitOrdersForPosition(position);

        // 2. Закрываем позицию маркет-ордером
        const closeReason = `emergency_stop_loss_pnl=${pnlUsd.toFixed(2)}$`;
        await this.engine.closePosition(position, closeReason);

        // 3. Логируем сделку в CSV
        const natr = this.natrService?.getNatr(position.coin) ?? undefined;
        const logEntry = this.tradeLogger.createLogEntry(position, currentPrice, closeReason, natr);
        this.tradeLogger.logTrade(logEntry);

        // 4. Удаляем позицию из списка открытых
        const index = this.openPositions.indexOf(position);
        if (index >= 0) {
          this.openPositions.splice(index, 1);
        }

        // 5. Очищаем кэш для этой позиции
        this.lastLoggedDensity.delete(position.id);
      }
    }
  }

  /**
   * Отмена всех лимитных ордеров для конкретной позиции.
   */
  private async cancelAllLimitOrdersForPosition(position: PositionState): Promise<void> {
    const allOrders = [
      ...(position.entryLimitOrders || []),
      ...(position.tpLimitOrders || []),
    ];

    if (allOrders.length === 0) {
      return;
    }

    console.log(`[Trading] Отмена ${allOrders.length} лимитных ордеров для ${position.coin} перед экстренным закрытием`);

    for (const order of allOrders) {
      if (!order.cancelled && !order.filled) {
        try {
          await this.engine.cancelLimitOrder(order);
          order.cancelled = true;
          order.cancelledAt = Date.now();
        } catch (err) {
          console.error(`[Trading] Ошибка при отмене ордера ${order.orderId}:`, err);
        }
      }
    }
  }

  /**
   * Расчёт размера позиции с учётом риска, NATR и политики (Спринт 9).
   * Если TRADE_MAX_RISK_PER_TRADE > 0, размер рассчитывается динамически.
   * Если POLICY_ENABLED = true, применяются контекстные правила.
   */
  private calculatePositionSize(coin: string, referencePrice: number): number {
    // Если риск не задан, используем фиксированный размер
    if (config.tradeMaxRiskPerTrade <= 0) {
      return config.tradePositionSizeUsd;
    }

    // Получаем NATR для монеты
    const natr = this.natrService?.getNatr(coin);
    if (!natr || natr <= 0) {
      console.warn(
        `[Trading] NATR для ${coin} недоступен для расчёта размера позиции, ` +
        `используем фиксированный размер ${config.tradePositionSizeUsd} USD`
      );
      return config.tradePositionSizeUsd;
    }

    // Расчёт ожидаемого движения цены (расстояние до SL)
    const riskMultiplier = config.tradeRiskNatrMultiplier;
    const priceMovementPercent = natr * riskMultiplier; // например, 0.5% * 2 = 1%

    // Расчёт размера позиции: Риск / Движение
    // Пример: 5$ / 1% = 500$
    const positionSizeUsd = config.tradeMaxRiskPerTrade / (priceMovementPercent / 100);

    if (config.logLevel === 'debug') {
      console.log(
        `[Trading] ${coin} динамический размер позиции: ` +
        `NATR=${natr.toFixed(2)}%, множитель=${riskMultiplier}, ` +
        `движение=${priceMovementPercent.toFixed(2)}%, риск=${config.tradeMaxRiskPerTrade}$, ` +
        `размер=${positionSizeUsd.toFixed(2)}$ (цена=${referencePrice.toFixed(4)})`
      );
    }

    return positionSizeUsd;
  }

  /**
   * Расчёт размера позиции с применением политики (Спринт 9).
   * Возвращает PolicyDecision с финальным размером и мультипликаторами.
   */
  private calculatePositionSizeWithPolicy(
    coin: string,
    referencePrice: number,
    anchorId: AnchorId
  ): { sizeUsd: number; decision: PolicyDecision } {
    // Базовый размер позиции
    const baseSize = this.calculatePositionSize(coin, referencePrice);
    
    // Если политика не включена, возвращаем базовый размер
    if (!config.policyEnabled || !this.positionPolicy || !this.contextFeatures || !this.anchorMemory) {
      return {
        sizeUsd: baseSize,
        decision: {
          allowTrade: true,
          sizeMultiplier: 1.0,
          tpNatrMultiplier: 1.0,
          slNatrMultiplier: 1.0,
          reason: 'policy_disabled',
        },
      };
    }

    // Обновляем историю NATR
    const natr = this.natrService?.getNatr(coin);
    if (natr) {
      this.contextFeatures.updateNatrHistory(coin, natr);
    }

    // Собираем контекстные фичи
    const features: ContextFeatures = {
      shock30mNatr: this.contextFeatures.calculateNatrShock(coin, 30 * 60 * 1000),
      shock60mNatr: this.contextFeatures.calculateNatrShock(coin, 60 * 60 * 1000),
      timeInAnchorZoneMin: 0, // Для новой позиции = 0
      timeSinceEntryMin: 0,   // Для новой позиции = 0
      anchorTradeCount: this.anchorMemory.getStats(anchorId)?.totalTrades || 0,
      anchorWinCount: this.anchorMemory.getStats(anchorId)?.winTrades || 0,
      anchorLastTradeAgoMin: this.anchorMemory.getMinutesSinceLastTrade(anchorId),
      tpHitsCount: 0, // Для новой позиции = 0
    };

    // Применяем политику
    const decision = this.positionPolicy.evaluatePolicy(features);

    // Применяем мультипликатор к размеру
    const finalSize = baseSize * decision.sizeMultiplier;

    if (config.logLevel === 'debug' || decision.reason !== 'default') {
      console.log(
        `[Trading] ${coin} политика применена: ` +
        `baseSizeUsd=${baseSize.toFixed(2)}, sizeMult=${decision.sizeMultiplier.toFixed(2)}, ` +
        `finalSize=${finalSize.toFixed(2)}, tpMult=${decision.tpNatrMultiplier.toFixed(2)}, ` +
        `reason="${decision.reason}", ` +
        `shock30m=${features.shock30mNatr.toFixed(2)}, shock60m=${features.shock60mNatr.toFixed(2)}`
      );
    }

    return { sizeUsd: finalSize, decision };
  }

  /**
   * Расчёт цен для лимитных ордеров относительно якорной цены плотности.
   * natrRange: [min, max] в NATR, например [-0.2, 0.4]
   * side: 'long' | 'short'
   * anchorPrice: цена плотности
   * natr: NATR в %
   * count: количество лимитных ордеров
   */
  private calculateLimitPrices(
    natrRange: [number, number],
    side: 'long' | 'short',
    anchorPrice: number,
    natr: number,
    count: number
  ): number[] {
    if (count <= 0 || !isFinite(anchorPrice) || anchorPrice <= 0 || !isFinite(natr) || natr <= 0) {
      return [];
    }

    const natrStep = anchorPrice * (natr / 100); // 1 NATR в ценовых единицах
    const [minNatr, maxNatr] = natrRange;

    // Для LONG:
    //   - отрицательные NATR = ниже якоря (за плотностью)
    //   - положительные NATR = выше якоря (перед плотностью)
    // Для SHORT:
    //   - отрицательные NATR = выше якоря (за плотностью)
    //   - положительные NATR = ниже якоря (перед плотностью)

    const prices: number[] = [];

    if (count === 1) {
      // Один ордер — размещаем в середине диапазона
      const midNatr = (minNatr + maxNatr) / 2;
      const delta = natrStep * midNatr;
      const price = side === 'long' ? anchorPrice + delta : anchorPrice - delta;
      prices.push(price);
    } else {
      // Несколько ордеров — распределяем равномерно
      const step = (maxNatr - minNatr) / (count - 1);
      for (let i = 0; i < count; i++) {
        const natrOffset = minNatr + step * i;
        const delta = natrStep * natrOffset;
        const price = side === 'long' ? anchorPrice + delta : anchorPrice - delta;
        prices.push(price);
      }
    }

    return prices.filter((p) => isFinite(p) && p > 0);
  }

  /**
   * Размещение лимитных ордеров на вход.
   */
  private async placeLimitEntryOrders(
    position: PositionState,
    anchorPrice: number,
    totalLimitSizeUsd: number,
    natr: number
  ): Promise<void> {
    if (totalLimitSizeUsd <= 0 || config.tradeEntryLimitProportions.length === 0) {
      return;
    }

    const proportions = config.tradeEntryLimitProportions;
    const totalProportion = proportions.reduce((sum, p) => sum + p, 0);
    if (totalProportion <= 0) {
      console.warn('[Trading] tradeEntryLimitProportions сумма <= 0, skip limit orders');
      return;
    }

    const count = proportions.length;
    const prices = this.calculateLimitPrices(
      config.tradeEntryLimitNatrRange,
      position.side,
      anchorPrice,
      natr,
      count
    );

    if (prices.length !== count) {
      console.error(`[Trading] Failed to calculate ${count} limit prices, got ${prices.length}`);
      return;
    }

    const side = position.side === 'long' ? 'buy' : 'sell';
    const orders: LimitOrderState[] = [];

    for (let i = 0; i < count; i++) {
      const sizeUsd = (totalLimitSizeUsd * proportions[i]) / totalProportion;
      const price = prices[i];

      const order = await this.engine.placeLimitOrder(position.coin, side, price, sizeUsd, 'entry');
      if (order) {
        orders.push(order);
      }
    }

    position.entryLimitOrders = orders;

    if (config.logLevel === 'debug') {
      console.log(
        `[Trading] Размещено ${orders.length} лимитных ордеров на вход для ${position.coin}: ` +
          orders.map((o) => `$${o.price.toFixed(4)} (${o.sizeUsd.toFixed(2)} USD)`).join(', ')
      );
    }
  }

  /**
   * Размещение лимитных ордеров на выход (TP).
   */
  private async placeLimitTpOrders(position: PositionState, natr: number): Promise<void> {
    if (
      !config.tradeTpNatrLevels.length ||
      config.tradeTpNatrLevels.length !== config.tradeTpPercents.length ||
      !config.tradeTpLimitProportions.length
    ) {
      return;
    }

    const tpProportions = config.tradeTpLimitProportions;
    const totalProportion = tpProportions.reduce((sum, p) => sum + p, 0);
    if (totalProportion <= 0) {
      return;
    }

    const natrStep = position.entryPrice * (natr / 100);
    const side = position.side === 'long' ? 'sell' : 'buy';
    const orders: LimitOrderState[] = [];

    // Размещаем TP лимитки на каждом уровне из tradeTpNatrLevels
    for (let levelIdx = 0; levelIdx < config.tradeTpNatrLevels.length; levelIdx++) {
      const level = config.tradeTpNatrLevels[levelIdx];
      const percent = config.tradeTpPercents[levelIdx];

      // Размер этого TP уровня
      const levelSizeUsd = position.sizeUsd * (percent / 100);

      // Цена для этого уровня
      const delta = natrStep * level;
      const price =
        position.side === 'long' ? position.entryPrice + delta : position.entryPrice - delta;

      // Распределяем levelSizeUsd по пропорциям
      const count = tpProportions.length;
      for (let i = 0; i < count; i++) {
        const sizeUsd = (levelSizeUsd * tpProportions[i]) / totalProportion;
        const order = await this.engine.placeLimitOrder(position.coin, side, price, sizeUsd, 'tp');
        if (order) {
          orders.push(order);
        }
      }
    }

    position.tpLimitOrders = orders;

    if (config.logLevel === 'debug' && orders.length) {
      console.log(
        `[Trading] Размещено ${orders.length} TP лимитных ордеров для ${position.coin}: ` +
          orders.map((o) => `$${o.price.toFixed(4)} (${o.sizeUsd.toFixed(2)} USD)`).join(', ')
      );
    }
  }

  /**
   * Отменить все активные лимитные ордера на вход для позиции.
   */
  private async cancelEntryLimitOrders(position: PositionState): Promise<void> {
    if (!position.entryLimitOrders || !position.entryLimitOrders.length) {
      return;
    }

    const activeOrders = position.entryLimitOrders.filter((o) => !o.filled && !o.cancelled);
    if (!activeOrders.length) {
      return;
    }

    console.log(`[Trading] Отменяем ${activeOrders.length} лимитных ордеров на вход для ${position.coin}`);

    for (const order of activeOrders) {
      await this.engine.cancelLimitOrder(order);
    }
  }

  async handleSignal(signal: TradeSignal): Promise<void> {
    if (!config.tradeEnabled || this.mode === 'SCREEN_ONLY') {
      // Торговый модуль выключен, ничего не делаем
      return;
    }

    if (this.context.mode === 'TRADE_PAPER' && config.tradeExecutionVenue !== 'PAPER') {
      // Дополнительная защита от случайной конфигурации
      console.warn(
        `[Trading] TRADE_MODE=TRADE_PAPER, но TRADE_EXECUTION_VENUE=${config.tradeExecutionVenue}. ` +
          'В текущей версии поддерживается только PAPER, сигнал проигнорирован.'
      );
      return;
    }

    if (!this.riskManager.canOpenPosition(signal, this.context, this.openPositions)) {
      return;
    }

    const position = await this.engine.openPosition(signal);
    if (!position) {
      return;
    }

    this.openPositions.push(position);
  }

  /**
   * Упрощённый адаптер: принимает LargeOrder напрямую от скринера
   * и конвертирует его в TradeSignal.
   */
  async onLargeOrder(order: LargeOrder): Promise<void> {
    const side: 'long' | 'short' = order.side === 'bid' ? 'long' : 'short';

    // Запрашиваем свечи для этой монеты, чтобы подсчитывать NATR
    this.candleFeed?.trackCoin(order.coin);

    // Подписываемся на trades для мгновенного обнаружения съедания заявок (всегда, не только в debug)
    if (this.hyperliquid) {
      this.hyperliquid.subscribeToTrades?.(order.coin, (tradeData: any) => {
        // Логируем только в debug режиме, но подписка активна всегда
        if (config.logLevel === 'debug') {
          console.log(
            `[Trading] ${order.coin} trade: ${tradeData.side} ${tradeData.sz} @ $${tradeData.px}`
          );
        }
        // TODO: можно добавить агрегацию trades для еще более быстрой реакции на деградацию
      });
    }

    const coinKey = order.coin.toUpperCase();

    if (!config.tradeEnabled || this.mode === 'SCREEN_ONLY') {
      return;
    }

    if (this.context.mode === 'TRADE_PAPER' && config.tradeExecutionVenue !== 'PAPER') {
      console.warn(
        `[Trading] TRADE_MODE=TRADE_PAPER, но TRADE_EXECUTION_VENUE=${config.tradeExecutionVenue}. ` +
          'В текущей версии поддерживается только PAPER, сигнал проигнорирован.'
      );
      return;
    }

    // Если по монете уже есть in-flight запрос на открытие позиции, не лезем ещё раз
    if (this.pendingCoins.has(coinKey)) {
      if (config.logLevel === 'debug') {
        console.log(`[Risk] pending openPosition for ${coinKey}, skip new signal`);
      }
      return;
    }

    // Если в памяти уже есть позиция по этой монете — не добавляем (даже если sizeUsd меньше TRADE_POSITION_SIZE_USD)
    if (this.openPositions.some((p) => p.coin.toUpperCase() === coinKey)) {
      if (config.logLevel === 'debug') {
        console.log(`[Risk] position for ${coinKey} already exists in openPositions, skip new signal`);
      }
      return;
    }

    // Рассчитываем размер позиции с учётом риска и NATR
    const targetPositionSizeUsd = this.calculatePositionSize(order.coin, order.price);

    const signal: TradeSignal = {
      coin: order.coin,
      side,
      referencePrice: order.price,
      targetPositionSizeUsd,
      sourceLargeOrder: order,
      source: 'liquidity',
    };

    if (!this.riskManager.canOpenPosition(signal, this.context, this.openPositions)) {
      return;
    }

    this.pendingCoins.add(coinKey);

    try {
      await this.executeEntry(signal, order);
    } finally {
      this.pendingCoins.delete(coinKey);
    }
  }

  /**
   * Исполнение входа в позицию в зависимости от режима (MARKET / LIMIT / MIXED).
   */
  private async executeEntry(signal: TradeSignal, order: LargeOrder): Promise<void> {
    const natr = this.natrService?.getNatr(order.coin);
    if (!natr || natr <= 0) {
      console.warn(`[Trading] NATR для ${order.coin} недоступен или <= 0, skip entry`);
        return;
      }

    const anchorInitialValueUsd = order.valueUsd;
    const anchorMinValueUsd = Math.max(
      anchorInitialValueUsd * config.tradeAnchorMinValueFraction,
      config.tradeAnchorMinValueUsd
    );

    const entryMode = config.tradeEntryMode;

    if (entryMode === 'MARKET') {
      // Только рыночный вход
      await this.executeMarketEntry(signal, order, natr, anchorInitialValueUsd, anchorMinValueUsd);
    } else if (entryMode === 'LIMIT') {
      // Только лимитный вход
      await this.executeLimitEntry(signal, order, natr, anchorInitialValueUsd, anchorMinValueUsd);
    } else if (entryMode === 'MIXED') {
      // Комбинированный вход: часть по рынку, часть лимитками
      await this.executeMixedEntry(signal, order, natr, anchorInitialValueUsd, anchorMinValueUsd);
    } else {
      console.warn(`[Trading] Unknown entry mode: ${entryMode}, skip entry`);
    }
  }

  /**
   * Рыночный вход (MARKET mode).
   */
  private async executeMarketEntry(
    signal: TradeSignal,
    order: LargeOrder,
    natr: number,
    anchorInitialValueUsd: number,
    anchorMinValueUsd: number
  ): Promise<void> {
    const position = await this.engine.openPosition(signal);
    if (!position) {
      return;
    }

    position.anchorSide = order.side;
    position.anchorPrice = order.price;
    position.anchorInitialValueUsd = anchorInitialValueUsd;
    position.anchorMinValueUsd = anchorMinValueUsd;
    position.marketFilledSizeUsd = position.sizeUsd;
    position.limitFilledSizeUsd = 0;

    // Размещаем TP лимитками (если настроено)
    if (config.tradeTpLimitProportions.length > 0) {
      await this.placeLimitTpOrders(position, natr);
    } else {
      // Старая логика TP по NATR (маркет-ордерами при достижении цены)
      this.setupTpTargets(position, natr);
    }

    this.openPositions.push(position);
  }

  /**
   * Лимитный вход (LIMIT mode).
   */
  private async executeLimitEntry(
    signal: TradeSignal,
    order: LargeOrder,
    natr: number,
    anchorInitialValueUsd: number,
    anchorMinValueUsd: number
  ): Promise<void> {
    // Создаём "пустую" позицию (sizeUsd=0), которая будет заполняться через лимитные ордера
    const position: PositionState = {
      id: `limit-entry-${Date.now()}`,
      coin: signal.coin,
      side: signal.side,
      entryPrice: signal.referencePrice,
      sizeUsd: signal.targetPositionSizeUsd,
      openedAt: Date.now(),
      anchorSide: order.side,
      anchorPrice: order.price,
      anchorInitialValueUsd,
      anchorMinValueUsd,
      marketFilledSizeUsd: 0,
      limitFilledSizeUsd: 0,
    };

    // Размещаем лимитные ордера на вход
    await this.placeLimitEntryOrders(position, order.price, signal.targetPositionSizeUsd, natr);

    this.openPositions.push(position);
  }

  /**
   * Комбинированный вход (MIXED mode): часть по рынку, часть лимитками.
   */
  private async executeMixedEntry(
    signal: TradeSignal,
    order: LargeOrder,
    natr: number,
    anchorInitialValueUsd: number,
    anchorMinValueUsd: number
  ): Promise<void> {
    const marketPercent = config.tradeEntryMarketPercent;
    const limitPercent = config.tradeEntryLimitPercent;
    const total = marketPercent + limitPercent;

    if (total <= 0) {
      console.warn('[Trading] MIXED mode: marketPercent + limitPercent <= 0, skip entry');
      return;
    }

    const marketSizeUsd = (signal.targetPositionSizeUsd * marketPercent) / total;
    const limitSizeUsd = (signal.targetPositionSizeUsd * limitPercent) / total;

    // Открываем рыночную часть
    const marketSignal: TradeSignal = { ...signal, targetPositionSizeUsd: marketSizeUsd };
    const position = await this.engine.openPosition(marketSignal);
    if (!position) {
      return;
    }

      position.anchorSide = order.side;
      position.anchorPrice = order.price;
      position.anchorInitialValueUsd = anchorInitialValueUsd;
      position.anchorMinValueUsd = anchorMinValueUsd;
    position.marketFilledSizeUsd = position.sizeUsd;
    position.limitFilledSizeUsd = 0;

    // Увеличиваем целевой размер позиции для учёта лимитной части
    position.sizeUsd = signal.targetPositionSizeUsd;

    // Размещаем лимитные ордера на вход
    if (limitSizeUsd > 0) {
      await this.placeLimitEntryOrders(position, order.price, limitSizeUsd, natr);
    }

    // Размещаем TP лимитками (если настроено)
    if (config.tradeTpLimitProportions.length > 0) {
      await this.placeLimitTpOrders(position, natr);
    } else {
      // Старая логика TP по NATR
      this.setupTpTargets(position, natr);
    }

    this.openPositions.push(position);
  }

  /**
   * Настройка TP-таргетов (старая логика для маркет-ордеров при достижении цены).
   */
  private setupTpTargets(position: PositionState, natr: number): void {
    if (
      !config.tradeTpNatrLevels.length ||
      config.tradeTpNatrLevels.length !== config.tradeTpPercents.length
    ) {
      return;
    }

    const step = position.entryPrice * (natr / 100);
          const tpTargets = config.tradeTpNatrLevels.map((level, idx) => {
            const percent = config.tradeTpPercents[idx];
            const delta = step * level;
            const price =
        position.side === 'long' ? position.entryPrice + delta : position.entryPrice - delta;
            const sizeUsd = position.sizeUsd * (percent / 100);
            return {
              price,
              sizeUsd,
              hit: false,
            };
          });

          position.tpTargets = tpTargets;

          if (config.logLevel === 'debug') {
            console.log(
              `[Trading] TP targets for ${position.coin}: ` +
          tpTargets.map((t) => `${t.sizeUsd.toFixed(2)} USD @ $${t.price.toFixed(4)}`).join(', ')
      );
    }
  }

  /**
   * Отслеживание разъедания/снятия лимитной заявки и закрытие позиции,
   * когда остаток <= 30% или <= 300k, либо уровень исчез из видимого стакана.
   */
  async onOrderBookSnapshot(snapshot: OrderBookSnapshot): Promise<void> {
    if (!config.tradeEnabled || this.mode === 'SCREEN_ONLY') {
      return;
    }

    const relevantPositions = this.openPositions.filter(
      (p) => p.coin === snapshot.coin && p.anchorPrice != null && p.anchorSide != null
    );

    if (!relevantPositions.length) {
      return;
    }

    const [rawBids, rawAsks] = snapshot.levels as unknown as [any[], any[]];

    const extractPriceSize = (level: any): { price: number; size: number } | null => {
      if (!level) return null;

      let priceRaw: any;
      let sizeRaw: any;

      if (Array.isArray(level)) {
        [priceRaw, sizeRaw] = level;
      } else if (typeof level === 'object') {
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
    };

    const positionsToClose: { position: PositionState; reason: string }[] = [];

    // Рассчитываем mid-price для TP по NATR и проверки зоны видимости плотности
    let midPrice: number | null = null;
    const bestBid = rawBids.length ? extractPriceSize(rawBids[0]) : null;
    const bestAsk = rawAsks.length ? extractPriceSize(rawAsks[0]) : null;
    if (bestBid && bestAsk) {
      midPrice = (bestBid.price + bestAsk.price) / 2;
      // Сохраняем текущую цену для PnL-мониторинга
      this.lastPrices.set(snapshot.coin, midPrice);
    }

    for (const position of relevantPositions) {
      const side = position.anchorSide!;
      const anchorPrice = position.anchorPrice!;
      const anchorMinValueUsd = position.anchorMinValueUsd ?? 0;

      const book = side === 'bid' ? rawBids : rawAsks;
      if (!book.length) {
        continue;
      }

      // Диапазон видимых цен в стакане для этой стороны (окно из ~20 тиков)
      const firstLevel = extractPriceSize(book[0]);
      const lastLevel = extractPriceSize(book[book.length - 1]);
      if (!firstLevel || !lastLevel) {
        continue;
      }

      let minVisible: number;
      let maxVisible: number;
      if (side === 'bid') {
        // bids идут от лучшего (max) к худшему (min)
        maxVisible = firstLevel.price;
        minVisible = lastLevel.price;
      } else {
        // asks идут от лучшего (min) к худшему (max)
        minVisible = firstLevel.price;
        maxVisible = lastLevel.price;
      }

      const anchorInRange = anchorPrice >= minVisible && anchorPrice <= maxVisible;

      let inView = false;
      let currentValueUsd = 0;

      for (const level of book) {
        const parsed = extractPriceSize(level);
        if (!parsed) continue;

        if (parsed.price === anchorPrice) {
          inView = true;
          currentValueUsd += parsed.price * parsed.size;
        }
      }

      // Если цена плотности вообще не попадает в окно стакана (20 тиков),
      // то смотрим направление ухода:
      // - если цена ушла ПРОТИВ нас и уровень "ниже/выше" области видимости — экстренно закрываем;
      // - если цена ушла В НАШУ СТОРОНУ (в сторону профита) — позицию не трогаем.
      if (!anchorInRange) {
        const movedAgainst =
          (side === 'bid' && anchorPrice > maxVisible) || // LONG: цена ушла ниже уровня плотности
          (side === 'ask' && anchorPrice < minVisible);   // SHORT: цена ушла выше уровня плотности

        if (movedAgainst) {
          positionsToClose.push({ position, reason: 'anchor_lost_out_of_view_against' });
        } else if (config.logLevel === 'debug') {
          console.log(
            `[Trading] Anchor price for ${position.coin} (${anchorPrice}) вне окна стакана ` +
              `[${minVisible}; ${maxVisible}] в сторону профита, позицию не закрываем.`
          );
        }
        continue;
      }

      // Цена плотности внутри окна и уровень пропал → считаем, что лимитку сняли/съели в зоне видимости.
      if (!inView) {
        console.warn(
          `[Trading] ⚠️ ${position.coin} ПЛОТНОСТЬ ИСЧЕЗЛА из стакана ` +
          `(якорь: $${anchorPrice.toFixed(4)}, окно: [$${minVisible.toFixed(4)}, $${maxVisible.toFixed(4)}])`
        );
        // Отменяем активные лимитные ордера на вход, если плотность пропала
        await this.cancelEntryLimitOrders(position);
        positionsToClose.push({ position, reason: 'anchor_removed_from_book_in_view' });
        continue;
      }

      // Проверяем деградацию плотности
      const anchorInitialValueUsd = position.anchorInitialValueUsd ?? currentValueUsd;
      const currentPercent = (currentValueUsd / anchorInitialValueUsd) * 100;
      const eatenUsd = anchorInitialValueUsd - currentValueUsd;
      const eatenPercent = 100 - currentPercent;

      // Умное логирование деградации плотности (только при существенных изменениях или в debug)
      if (anchorInitialValueUsd > 0) {
        const lastLogged = this.lastLoggedDensity.get(position.id);
        const now = Date.now();
        const timeSinceOpen = now - position.openedAt;
        const secondsElapsed = Math.round(timeSinceOpen / 1000);
        
        // Логируем если:
        // 1. DEBUG режим (всегда)
        // 2. Изменение > 5% от последнего залогированного значения
        // 3. Прошло > 10 секунд с последнего лога
        // 4. Первый раз для этой позиции
        const shouldLog = 
          config.logLevel === 'debug' ||
          !lastLogged ||
          Math.abs(currentPercent - lastLogged.percent) >= 5 ||
          (now - lastLogged.time) >= 10000;

        if (shouldLog) {
          console.log(
            `[Trading] ${position.coin} плотность: ${currentValueUsd.toFixed(0)}/${anchorInitialValueUsd.toFixed(0)} USD ` +
            `(${currentPercent.toFixed(1)}% осталось, ${eatenPercent.toFixed(1)}% съели), ` +
            `съедено: $${eatenUsd.toFixed(0)}, время: ${secondsElapsed}s`
          );
          this.lastLoggedDensity.set(position.id, { percent: currentPercent, time: now });
        }
      }

      // Если плотность деградировала ниже порога, отменяем лимитные ордера на вход
      if (
        position.entryLimitOrders &&
        position.entryLimitOrders.length > 0 &&
        currentPercent < config.tradeEntryLimitDensityMinPercent
      ) {
        console.warn(
          `[Trading] ⚠️ ${position.coin} ДЕГРАДАЦИЯ ПЛОТНОСТИ! ` +
          `${currentPercent.toFixed(1)}% < порог ${config.tradeEntryLimitDensityMinPercent}%, ` +
          `отменяем ${position.entryLimitOrders.filter(o => !o.cancelled && !o.filled).length} активных лимитных ордеров`
        );
        await this.cancelEntryLimitOrders(position);
      }

      // Проверяем исполнение лимитных ордеров на вход (эмуляция для paper-режима)
      if (midPrice != null && position.entryLimitOrders && position.entryLimitOrders.length) {
        for (const order of position.entryLimitOrders) {
          if (order.filled || order.cancelled) continue;

          // Проверяем, достигла ли цена уровня лимитного ордера
          const filled =
            (order.side === 'buy' && midPrice <= order.price) ||
            (order.side === 'sell' && midPrice >= order.price);

          if (filled) {
            order.filled = true;
            order.filledAt = Date.now();
            position.limitFilledSizeUsd = (position.limitFilledSizeUsd || 0) + order.sizeUsd;

            if (config.logLevel === 'debug') {
              console.log(
                `[Trading] Лимитный ордер на вход ${order.orderId} исполнен: ${order.side.toUpperCase()} ${
                  position.coin
                } @ $${order.price.toFixed(4)}, sizeUsd=${order.sizeUsd.toFixed(2)}`
              );
            }

            // После исполнения лимитного ордера размещаем TP лимитки (если ещё не размещены)
            if (
              config.tradeTpLimitProportions.length > 0 &&
              (!position.tpLimitOrders || position.tpLimitOrders.length === 0)
            ) {
              const natr = this.natrService?.getNatr(position.coin);
              if (natr && natr > 0) {
                await this.placeLimitTpOrders(position, natr);
              }
            }
          }
        }
      }

      // Проверяем исполнение TP лимитных ордеров (эмуляция для paper-режима)
      if (midPrice != null && position.tpLimitOrders && position.tpLimitOrders.length) {
        for (const order of position.tpLimitOrders) {
          if (order.filled || order.cancelled) continue;

          const filled =
            (order.side === 'buy' && midPrice <= order.price) ||
            (order.side === 'sell' && midPrice >= order.price);

          if (filled) {
            order.filled = true;
            order.filledAt = Date.now();
            position.sizeUsd -= order.sizeUsd;

            console.log(
              `[Trading] TP лимитный ордер ${order.orderId} исполнен: ${order.side.toUpperCase()} ${
                position.coin
              } @ $${order.price.toFixed(4)}, sizeUsd=${order.sizeUsd.toFixed(2)}`
            );

            // Если позиция полностью закрыта через TP лимитки
            if (position.sizeUsd <= 0) {
              positionsToClose.push({ position, reason: 'tp_limit_all_hit' });
              break;
            }
          }
        }
      }

      if (currentValueUsd <= anchorMinValueUsd) {
        positionsToClose.push({ position, reason: 'anchor_value_below_threshold' });
        continue;
      }

      // TP по NATR (частичные выходы)
      if (midPrice != null && position.tpTargets && position.tpTargets.length) {
        for (const target of position.tpTargets) {
          if (target.hit || target.sizeUsd <= 0) continue;

          const hit =
            position.side === 'long'
              ? midPrice >= target.price
              : midPrice <= target.price;

          if (!hit) continue;

          const partial: PositionState = {
            ...position,
            sizeUsd: target.sizeUsd,
          };

          this.engine
            .closePosition(partial, 'tp_hit')
            .catch((err) =>
              console.error('[Trading] Failed to close partial position for TP:', err)
            );

          position.sizeUsd -= target.sizeUsd;
          target.hit = true;
        }

        // Если после TP позиция фактически обнулена, закрываем остаток
        if (position.sizeUsd <= 0) {
          positionsToClose.push({ position, reason: 'tp_all_hit' });
        }
      }
    }

    if (!positionsToClose.length) {
      return;
    }

    // Закрываем позиции и логируем их в CSV
    for (const { position, reason } of positionsToClose) {
      // Получаем текущую цену для логирования
      const exitPrice = midPrice || this.lastPrices.get(position.coin) || position.entryPrice;
      
      // Закрываем позицию
      this.engine
        .closePosition(position, reason)
        .catch((err) => console.error('[Trading] Failed to close position:', err));
      
      // Логируем сделку в CSV
      const natr = this.natrService?.getNatr(position.coin) ?? undefined;
      const logEntry = this.tradeLogger.createLogEntry(position, exitPrice, reason, natr);
      this.tradeLogger.logTrade(logEntry);
    }

    const idsToClose = new Set(positionsToClose.map((p) => p.position.id));
    
    // Очищаем кеш логирования для закрытых позиций
    for (const id of idsToClose) {
      this.lastLoggedDensity.delete(id);
    }
    
    this.openPositions.splice(
      0,
      this.openPositions.length,
      ...this.openPositions.filter((p) => !idsToClose.has(p.id))
    );
  }

  async shutdown(): Promise<void> {
    // Останавливаем PnL-мониторинг
    if (this.pnlCheckInterval) {
      clearInterval(this.pnlCheckInterval);
      this.pnlCheckInterval = undefined;
      console.log('[Trading] PnL-мониторинг остановлен');
    }

    // В paper-режиме просто логируем закрытие.
    if (this.openPositions.length > 0) {
      console.log(`[Trading] Shutdown: всего открытых виртуальных позиций: ${this.openPositions.length}`);
    }
  }
}



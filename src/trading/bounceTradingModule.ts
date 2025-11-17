import { config } from '../config';
import { LargeOrder, OrderBookSnapshot } from '../types';
import { NatrService } from '../indicators/natr';
import { BinanceCandleFeed } from '../data/binanceCandleFeed';
import {
  ExecutionEngine,
  PositionState,
  RiskManager,
  TradeSignal,
  TradingContext,
  TradingModule,
} from './interfaces';

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
  /**
   * Защита от конкурирующих входов: пока по монете есть in-flight openPosition, не открываем новую.
   */
  private readonly pendingCoins = new Set<string>();

  constructor(engine: ExecutionEngine, natrService?: NatrService, candleFeed?: BinanceCandleFeed, riskManager?: RiskManager) {
    this.engine = engine;
    this.natrService = natrService;
    this.candleFeed = candleFeed;
    this.riskManager = riskManager ?? new BasicRiskManager();
    this.context = {
      mode: config.tradeMode,
      maxOpenPositions: config.tradeMaxOpenPositions,
      dailyMaxLoss: config.tradeDailyMaxLoss,
      dailyMaxTrades: config.tradeDailyMaxTrades,
    };

    console.log(
      `[Trading] BounceTradingModule инициализирован в режиме ${this.context.mode}, ` +
        `executionVenue=${config.tradeExecutionVenue}, tradeEnabled=${config.tradeEnabled}`
    );
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

    const signal: TradeSignal = {
      coin: order.coin,
      side,
      referencePrice: order.price,
      targetPositionSizeUsd: config.tradePositionSizeUsd,
      sourceLargeOrder: order,
      source: 'liquidity',
    };

    // Запрашиваем свечи для этой монеты, чтобы подсчитывать NATR
    this.candleFeed?.trackCoin(order.coin);

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

    if (!this.riskManager.canOpenPosition(signal, this.context, this.openPositions)) {
      return;
    }

    this.pendingCoins.add(coinKey);

    try {
      const position = await this.engine.openPosition(signal);
      if (!position) {
        return;
      }

      // Привязываем к позиции информацию о плотности, от которой зашли
    const anchorInitialValueUsd = order.valueUsd;
    const anchorMinValueUsd = Math.max(
      anchorInitialValueUsd * config.tradeAnchorMinValueFraction,
      config.tradeAnchorMinValueUsd
    );

      position.anchorSide = order.side;
      position.anchorPrice = order.price;
      position.anchorInitialValueUsd = anchorInitialValueUsd;
      position.anchorMinValueUsd = anchorMinValueUsd;

      // Рассчитываем TP по NATR, если NATR доступен и конфиг корректен
      if (
        this.natrService &&
        config.tradeTpNatrLevels.length &&
        config.tradeTpNatrLevels.length === config.tradeTpPercents.length
      ) {
        const natr = this.natrService.getNatr(order.coin);
        if (natr != null && natr > 0) {
          const step = position.entryPrice * (natr / 100); // 1 NATR в ценовых единицах
          const tpTargets = config.tradeTpNatrLevels.map((level, idx) => {
            const percent = config.tradeTpPercents[idx];
            const delta = step * level;
            const price =
              side === 'long' ? position.entryPrice + delta : position.entryPrice - delta;
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
                tpTargets
                  .map((t) => `${t.sizeUsd.toFixed(2)} USD @ $${t.price.toFixed(4)}`)
                  .join(', ')
            );
          }
        }
      }

      this.openPositions.push(position);
    } finally {
      this.pendingCoins.delete(coinKey);
    }
  }

  /**
   * Отслеживание разъедания/снятия лимитной заявки и закрытие позиции,
   * когда остаток <= 30% или <= 300k, либо уровень исчез из видимого стакана.
   */
  onOrderBookSnapshot(snapshot: OrderBookSnapshot): void {
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
        positionsToClose.push({ position, reason: 'anchor_removed_from_book_in_view' });
        continue;
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

    for (const { position, reason } of positionsToClose) {
      this.engine
        .closePosition(position, reason)
        .catch((err) => console.error('[Trading] Failed to close position:', err));
    }

    const idsToClose = new Set(positionsToClose.map((p) => p.position.id));
    this.openPositions.splice(
      0,
      this.openPositions.length,
      ...this.openPositions.filter((p) => !idsToClose.has(p.id))
    );
  }

  async shutdown(): Promise<void> {
    // В paper-режиме просто логируем закрытие.
    if (this.openPositions.length > 0) {
      console.log(`[Trading] Shutdown: всего открытых виртуальных позиций: ${this.openPositions.length}`);
    }
  }
}



import { ExecutionEngine, PositionState, TradeSignal, LimitOrderState } from './interfaces';
import { config } from '../config';

let nextId = 1;
let nextOrderId = 1;

/**
 * PaperExecutionEngine — безопасный движок, который только логирует
 * и эмулирует открытие/закрытие позиций без реальных ордеров.
 */
export class PaperExecutionEngine implements ExecutionEngine {
  async openPosition(signal: TradeSignal): Promise<PositionState | null> {
    if (config.tradePositionSizeUsd <= 0) {
      if (config.logLevel === 'debug') {
        console.log('[PaperExecution] tradePositionSizeUsd <= 0, пропускаем открытие позиции');
      }
      return null;
    }

    const id = `paper-${Date.now()}-${nextId++}`;

    const position: PositionState = {
      id,
      coin: signal.coin,
      side: signal.side,
      entryPrice: signal.referencePrice,
      sizeUsd: signal.targetPositionSizeUsd,
      openedAt: Date.now(),
    };

    console.log(
      `[PaperExecution] Открыли виртуальную позицию: ${position.side.toUpperCase()} ${position.coin} ` +
        `sizeUsd=${position.sizeUsd} @ $${position.entryPrice.toFixed(4)} (signal source=${signal.source})`
    );

    return position;
  }

  async closePosition(position: PositionState, reason: string): Promise<void> {
    const now = Date.now();
    const heldMs = now - position.openedAt;
    console.log(
      `[PaperExecution] Закрыли виртуальную позицию ${position.id}: ${position.side.toUpperCase()} ${position.coin} ` +
        `sizeUsd=${position.sizeUsd} @ ~${position.entryPrice.toFixed(4)}, held=${Math.round(heldMs / 1000)}s, reason=${reason}`
    );
  }

  async placeLimitOrder(
    coin: string,
    side: 'buy' | 'sell',
    price: number,
    sizeUsd: number,
    purpose: 'entry' | 'tp',
    contracts?: number
  ): Promise<LimitOrderState | null> {
    const orderId = `paper-limit-${Date.now()}-${nextOrderId++}`;
    
    const order: LimitOrderState = {
      orderId,
      coin,
      price,
      sizeUsd,
      contracts, // Сохраняем contracts если передан
      side,
      purpose,
      placedAt: Date.now(),
      filled: false,
      cancelled: false,
    };

    console.log(
      `[PaperExecution] Выставили виртуальный лимитный ордер: ${side.toUpperCase()} ${coin} ` +
        `sizeUsd=${sizeUsd.toFixed(2)}${contracts ? ` (${contracts} contracts)` : ''} @ $${price.toFixed(4)} ` +
        `(purpose=${purpose}, orderId=${orderId})`
    );

    return order;
  }

  async cancelLimitOrder(order: LimitOrderState): Promise<void> {
    if (order.cancelled || order.filled) {
      if (config.logLevel === 'debug') {
        console.log(
          `[PaperExecution] Ордер ${order.orderId} уже ${order.cancelled ? 'отменён' : 'заполнен'}, skip cancel`
        );
      }
      return;
    }

    order.cancelled = true;
    order.cancelledAt = Date.now();

    console.log(
      `[PaperExecution] Отменили виртуальный лимитный ордер ${order.orderId}: ` +
        `${order.side.toUpperCase()} @ $${order.price.toFixed(4)}, sizeUsd=${order.sizeUsd.toFixed(2)}`
    );
  }

  async checkLimitOrderStatus(order: LimitOrderState): Promise<{ filled: boolean; filledSize?: number }> {
    // В paper-режиме мы не эмулируем реальное исполнение лимитных ордеров,
    // это будет делаться в логике bounceTradingModule при отслеживании стакана
    return { filled: order.filled || false, filledSize: order.filled ? order.sizeUsd : 0 };
  }

  async getCurrentPositions(): Promise<Array<{
    coin: string;
    side: 'long' | 'short';
    entryPrice: number;
    currentPrice: number;
    sizeUsd: number;
    pnlUsd: number;
  }>> {
    // В paper-режиме позиции управляются торговым модулем напрямую,
    // поэтому этот метод не используется
    return [];
  }
}



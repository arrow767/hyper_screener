import { ExecutionEngine, PositionState, TradeSignal } from './interfaces';
import { config } from '../config';

let nextId = 1;

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
}



import { ExecutionEngine, PositionState, TradeSignal } from './interfaces';

/**
 * ВРЕМЕННО: HyperliquidExecutionEngine работает как заглушка.
 *
 * Причина: окружение не видит внутренних модулей SDK (@nktkas/hyperliquid/utils, /api/exchange),
 * что ломает сборку. Чтобы не блокировать работу бота, Hyperliquid-трейдинг отключён,
 * а реальный боевой режим сейчас доступен только через BinanceExecutionEngine.
 */
export class HyperliquidExecutionEngine implements ExecutionEngine {
  async openPosition(signal: TradeSignal): Promise<PositionState | null> {
    console.warn(
      `[HyperliquidExecution] LIVE trading for Hyperliquid временно отключён. ` +
        `Запрос на открытие ${signal.side.toUpperCase()} ${signal.coin} sizeUsd=${signal.targetPositionSizeUsd} @ $${signal.referencePrice.toFixed(
          4
        )} только залогирован.`
    );
    return null;
  }

  async closePosition(position: PositionState, reason: string): Promise<void> {
    console.warn(
      `[HyperliquidExecution] LIVE trading for Hyperliquid временно отключён. ` +
        `Запрос на закрытие позиции ${position.id} (${position.side.toUpperCase()} ${position.coin}, sizeUsd=${position.sizeUsd}) reason=${reason} только залогирован.`
    );
  }

  async syncOpenPositions(): Promise<void> {
    console.warn(
      '[HyperliquidExecution] Position sync для Hyperliquid не реализован. ' +
        'Если на бирже есть открытые позиции, бот их не трогает и не учитывает.'
    );
  }
}


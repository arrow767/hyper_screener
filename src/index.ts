import { OrderBookMonitor } from './orderbook-monitor';
import { config, validateConfig } from './config';
import { BounceTradingModule } from './trading/bounceTradingModule';
import { PaperExecutionEngine } from './trading/paperExecutionEngine';
import { HyperliquidExecutionEngine } from './trading/hyperliquidExecutionEngine';
import { BinanceExecutionEngine } from './trading/binanceExecutionEngine';
import { ExecutionEngine } from './trading/interfaces';
import { NatrService } from './indicators/natr';
import { BinanceCandleFeed } from './data/binanceCandleFeed';

async function main() {
  console.log('='.repeat(60));
  console.log('  Hyperliquid Large Order Screener');
  console.log('='.repeat(60));
  console.log('');

  try {
    validateConfig();
    console.log('[Main] Configuration validated successfully');
  } catch (error) {
    console.error('[Main] Configuration error:', error);
    process.exit(1);
  }

  let tradingModule: BounceTradingModule | undefined;
  let natrService: NatrService | undefined;
  let candleFeed: BinanceCandleFeed | undefined;

  if (config.tradeEnabled && config.tradeMode !== 'SCREEN_ONLY') {
    natrService = new NatrService(config.tradeNatrPeriod);
    candleFeed = new BinanceCandleFeed(natrService);
    candleFeed.start();

    let engine: ExecutionEngine | undefined;

    switch (config.tradeExecutionVenue) {
      case 'PAPER':
        engine = new PaperExecutionEngine();
        break;
      case 'HYPERLIQUID':
        engine = new HyperliquidExecutionEngine();
        break;
      case 'BINANCE':
        engine = new BinanceExecutionEngine();
        break;
      default:
        console.warn(
          `[Main] Неподдерживаемое значение TRADE_EXECUTION_VENUE=${config.tradeExecutionVenue}, торговый модуль не активирован.`
        );
    }

    if (engine) {
      // Упрощённый sync: только логируем внешние открытые позиции
      await engine.syncOpenPositions?.();
      tradingModule = new BounceTradingModule(engine, natrService, candleFeed);
    }
  }

  const monitor = new OrderBookMonitor(tradingModule);
  
  // Передаём hyperliquid клиент в trading module для подписки на trades
  if (tradingModule) {
    (tradingModule as any).hyperliquid = monitor.getHyperliquidClient();
  }

  process.on('SIGINT', () => {
    console.log('\n[Main] Received SIGINT, shutting down gracefully...');
    monitor.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Main] Received SIGTERM, shutting down gracefully...');
    monitor.stop();
    process.exit(0);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[Main] Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('[Main] Uncaught Exception:', error);
    monitor.stop();
    process.exit(1);
  });

  try {
    await monitor.start();
  } catch (error) {
    console.error('[Main] Failed to start monitor:', error);
    process.exit(1);
  }
}

main();


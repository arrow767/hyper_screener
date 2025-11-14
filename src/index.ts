import { OrderBookMonitor } from './orderbook-monitor';
import { config, validateConfig } from './config';

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

  const monitor = new OrderBookMonitor();

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


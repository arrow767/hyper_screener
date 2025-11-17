import { config as dotenvConfig } from 'dotenv';
import { Config, TradeMode, TradeExecutionVenue } from './types';

dotenvConfig();

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

function getEnvTradeMode(name: string, defaultValue: TradeMode): TradeMode {
  const value = process.env[name];
  if (!value) return defaultValue;

  const upper = value.toUpperCase();
  if (upper === 'SCREEN_ONLY' || upper === 'TRADE_PAPER' || upper === 'TRADE_LIVE') {
    return upper as TradeMode;
  }

  return defaultValue;
}

function getEnvExecutionVenue(name: string, defaultValue: TradeExecutionVenue): TradeExecutionVenue {
  const value = process.env[name];
  if (!value) return defaultValue;

  const upper = value.toUpperCase();
  if (upper === 'PAPER' || upper === 'HYPERLIQUID' || upper === 'BINANCE') {
    return upper as TradeExecutionVenue;
  }

  return defaultValue;
}

function parsePerCoinMinOrderSizeUsd(envValue: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!envValue) return result;

  // Формат: "BTC:5000000,ETH:3000000,SOL:1000000"
  const pairs = envValue.split(',');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const [rawCoin, rawValue] = trimmed.split(':');
    const coin = rawCoin?.trim();
    const value = rawValue ? parseFloat(rawValue.trim()) : NaN;

    if (!coin || !isFinite(value) || value <= 0) {
      // Игнорируем некорректные записи, но не падаем
      // Можно включить логирование в debug-режиме, если нужно
      continue;
    }

    result[coin.toUpperCase()] = value;
  }

  return result;
}

function parseNumberArray(envValue: string | undefined): number[] {
  if (!envValue) return [];
  return envValue
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((v) => parseFloat(v))
    .filter((v) => isFinite(v));
}

function parseRange(envValue: string | undefined, defaultRange: [number, number]): [number, number] {
  if (!envValue) return defaultRange;

  try {
    // Ожидаемый формат: "[1,2]" или "1,2"
    const cleaned = envValue.replace(/[\[\]]/g, '');
    const parts = cleaned.split(',').map((p) => parseFloat(p.trim()));
    if (parts.length === 2 && isFinite(parts[0]) && isFinite(parts[1])) {
      return [parts[0], parts[1]];
    }
    return defaultRange;
  } catch {
    return defaultRange;
  }
}

export const config: Config = {
  telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
  telegramChatId: getEnvVar('TELEGRAM_CHAT_ID'),
  minOrderSizeUsd: getEnvNumber('MIN_ORDER_SIZE_USD', 2000000),
  maxDistancePercent: getEnvNumber('MAX_DISTANCE_PERCENT', 0.2),
  alertCooldownMs: getEnvNumber('ALERT_COOLDOWN_MS', 60000),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  perCoinMinOrderSizeUsd: parsePerCoinMinOrderSizeUsd(process.env.MIN_ORDER_SIZE_USD_OVERRIDES),

  // Trading config (по умолчанию торговый модуль выключен)
  tradeEnabled: getEnvBool('TRADE_ENABLED', false),
  tradeMode: getEnvTradeMode('TRADE_MODE', 'SCREEN_ONLY'),
  tradePositionSizeUsd: getEnvNumber('TRADE_POSITION_SIZE_USD', 0),
  tradeMaxRiskPerTrade: getEnvNumber('TRADE_MAX_RISK_PER_TRADE', 0),
  tradeMaxOpenPositions: getEnvNumber('TRADE_MAX_OPEN_POSITIONS', 1),
  tradeNatrPeriod: getEnvNumber('TRADE_NATR_PERIOD', 14),
  tradeNatrTimeframe: process.env.TRADE_NATR_TIMEFRAME || '5m',
  tradeEntryNatrRange: parseRange(process.env.TRADE_ENTRY_NATR_RANGE, [1, 2]),
  tradeTpNatrLevels: parseNumberArray(process.env.TRADE_TP_NATR_LEVELS),
  tradeTpPercents: parseNumberArray(process.env.TRADE_TP_PERCENTS),
  tradeSlTickOffset: getEnvNumber('TRADE_SL_TICK_OFFSET', 1),
  tradeDailyMaxLoss: getEnvNumber('TRADE_DAILY_MAX_LOSS', 0),
  tradeDailyMaxTrades: getEnvNumber('TRADE_DAILY_MAX_TRADES', 0),
  tradeAnchorMinValueFraction: getEnvNumber('TRADE_ANCHOR_MIN_VALUE_FRACTION', 0.3),
  tradeAnchorMinValueUsd: getEnvNumber('TRADE_ANCHOR_MIN_VALUE_USD', 300000),
  tradeExecutionVenue: getEnvExecutionVenue('TRADE_EXECUTION_VENUE', 'PAPER'),
};

export function validateConfig(): void {
  if (config.minOrderSizeUsd <= 0) {
    throw new Error('MIN_ORDER_SIZE_USD must be positive');
  }
  if (config.maxDistancePercent <= 0 || config.maxDistancePercent > 100) {
    throw new Error('MAX_DISTANCE_PERCENT must be between 0 and 100');
  }
  if (config.alertCooldownMs < 0) {
    throw new Error('ALERT_COOLDOWN_MS must be non-negative');
  }

  // Базовая валидация торгового конфига (не блокирует работу скринера)
  if (config.tradeEnabled || config.tradeMode !== 'SCREEN_ONLY') {
    if (config.tradePositionSizeUsd <= 0) {
      console.warn('[Config] tradePositionSizeUsd <= 0 при включённом торговом режиме — торговый модуль не будет открывать позиции.');
    }
    if (config.tradeTpNatrLevels.length !== config.tradeTpPercents.length) {
      console.warn('[Config] tradeTpNatrLevels и tradeTpPercents имеют разную длину — лесенка TP может быть некорректной.');
    }
  }
}


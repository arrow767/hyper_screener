import { config as dotenvConfig } from 'dotenv';
import { Config } from './types';

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

export const config: Config = {
  telegramBotToken: getEnvVar('TELEGRAM_BOT_TOKEN'),
  telegramChatId: getEnvVar('TELEGRAM_CHAT_ID'),
  minOrderSizeUsd: getEnvNumber('MIN_ORDER_SIZE_USD', 2000000),
  maxDistancePercent: getEnvNumber('MAX_DISTANCE_PERCENT', 0.2),
  alertCooldownMs: getEnvNumber('ALERT_COOLDOWN_MS', 60000),
  logLevel: getEnvVar('LOG_LEVEL', 'info'),
  perCoinMinOrderSizeUsd: parsePerCoinMinOrderSizeUsd(process.env.MIN_ORDER_SIZE_USD_OVERRIDES),
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
}


import { Telegraf } from 'telegraf';
import { LargeOrder } from './types';
import { config } from './config';

export class TelegramNotifier {
  private bot: Telegraf;
  private lastAlerts = new Map<string, number>();
  private globalRateLimitUntil = 0;
  private isEnabled = false; // ✅ Флаг доступности Telegram

  constructor() {
    this.bot = new Telegraf(config.telegramBotToken);
  }

  async initialize(): Promise<void> {
    try {
      const me = await this.bot.telegram.getMe();
      console.log(`[Telegram] ✅ Bot initialized: @${me.username}`);
      this.isEnabled = true; // ✅ Telegram доступен
    } catch (error) {
      console.error('[Telegram] ❌ Failed to initialize bot:', error);
      console.warn('[Telegram] ⚠️ Bot will work WITHOUT Telegram notifications');
      this.isEnabled = false; // ✅ Telegram недоступен, но работаем
      // НЕ бросаем ошибку! Бот должен работать без Telegram
    }
  }

  async sendAlert(order: LargeOrder): Promise<void> {
    // ✅ Если Telegram недоступен - только логируем в консоль
    if (!this.isEnabled) {
      const sideText = order.side === 'bid' ? 'BUY' : 'SELL';
      console.log(
        `[Alert] ${sideText} ${order.coin} @ $${order.price.toFixed(4)} | ` +
          `size=${order.size.toFixed(2)} | value=$${this.formatNumber(order.valueUsd)} | ` +
          `distance=${order.distancePercent.toFixed(3)}% | ` +
          `time=${this.formatTimestamp(new Date(order.timestamp))}`
      );
      return;
    }

    // Грубый дедуп: одна заявка на coin+side в период cooldown
    const alertKey = `${order.coin}-${order.side}`;
    const now = Date.now();

    // Глобальный rate limit от Telegram (по коду 429 retry_after)
    if (now < this.globalRateLimitUntil) {
      if (config.logLevel === 'debug') {
        console.log(
          `[Telegram] Skipping alert due to global rate limit, retry after ${new Date(
            this.globalRateLimitUntil
          ).toISOString()}`
        );
      }
      return;
    }

    const lastAlert = this.lastAlerts.get(alertKey);

    if (lastAlert && now - lastAlert < config.alertCooldownMs) {
      return;
    }

    this.lastAlerts.set(alertKey, now);

    const emoji = order.side === 'bid' ? '🟢' : '🔴';
    const sideText = order.side === 'bid' ? 'BUY' : 'SELL';
    
    const message = this.formatMessage(order, emoji, sideText);

    // Логируем алерт в консоль помимо отправки в Telegram
    console.log(
      `[Alert] ${sideText} ${order.coin} @ $${order.price.toFixed(4)} | ` +
        `size=${order.size.toFixed(2)} | value=$${this.formatNumber(order.valueUsd)} | ` +
        `distance=${order.distancePercent.toFixed(3)}% | ` +
        `time=${this.formatTimestamp(new Date(order.timestamp))}`
    );

    try {
      await this.bot.telegram.sendMessage(config.telegramChatId, message, {
        parse_mode: 'HTML',
      });
      console.log(`[Telegram] Alert sent for ${order.coin} ${sideText}`);
    } catch (error: any) {
      // Обработка rate limit 429 с учётом retry_after
      const description = error?.response?.description;
      const retryAfter = error?.response?.parameters?.retry_after;

      if (retryAfter && typeof retryAfter === 'number') {
        this.globalRateLimitUntil = Date.now() + retryAfter * 1000;
        console.warn(
          `[Telegram] Rate limited (429). Pausing alerts for ${retryAfter}s (until ${new Date(
            this.globalRateLimitUntil
          ).toISOString()})`
        );
      } else {
        console.error('[Telegram] Failed to send alert:', error);
      }
    }
  }

  private formatMessage(order: LargeOrder, emoji: string, sideText: string): string {
    return `${emoji} <b>LARGE ${sideText} ORDER DETECTED</b>

<b>Coin:</b> ${order.coin}
<b>Side:</b> ${sideText}
<b>Price:</b> $${order.price.toFixed(4)}
<b>Size:</b> ${order.size.toFixed(2)} contracts
<b>Value:</b> $${this.formatNumber(order.valueUsd)}
<b>Distance:</b> ${order.distancePercent.toFixed(3)}%

<i>Time: ${this.formatTimestamp(new Date(order.timestamp))}</i>`;
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(2)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(2)}K`;
    }
    return num.toFixed(2);
  }

  private formatTimestamp(date: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');

    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    const day = pad(date.getDate());
    const month = pad(date.getMonth() + 1);
    const year = pad(date.getFullYear() % 100);

    return `${hours}:${minutes}:${seconds} ${day}.${month}.${year}`;
  }

  /**
   * Отправить произвольное сообщение в Telegram (без дедупликации)
   */
  async sendMessage(message: string): Promise<void> {
    // ✅ Если Telegram недоступен - только логируем
    if (!this.isEnabled) {
      console.log('[Telegram] (offline) Message:', message.substring(0, 100));
      return;
    }

    try {
      await this.bot.telegram.sendMessage(config.telegramChatId, message, {
        parse_mode: 'HTML',
      });
      console.log('[Telegram] Message sent');
    } catch (error: any) {
      console.error('[Telegram] Failed to send message:', error);
    }
  }

  cleanup(): void {
    const oneHourAgo = Date.now() - 3600000;
    for (const [key, timestamp] of this.lastAlerts.entries()) {
      if (timestamp < oneHourAgo) {
        this.lastAlerts.delete(key);
      }
    }
  }
}


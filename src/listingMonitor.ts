import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

/**
 * Информация о новом листинге.
 */
export interface ListingInfo {
  coin: string;
  detectedAt: Date;
  notifiedAt?: Date;
}

/**
 * Монитор новых листингов на Hyperliquid.
 * Отслеживает появление новых монет и отправляет уведомления один раз.
 */
export class ListingMonitor {
  private knownCoins: Set<string> = new Set();
  private notifiedCoins: Set<string> = new Set();
  private readonly historyFilePath: string;
  private readonly enabled: boolean;
  private lastCheckTime: number = 0;
  private readonly checkIntervalMs: number;

  constructor(
    historyFilePath: string = './data/listing_history.json',
    enabled: boolean = true,
    checkIntervalMs: number = 60000 // 1 минута по умолчанию
  ) {
    this.historyFilePath = historyFilePath;
    this.enabled = enabled;
    this.checkIntervalMs = checkIntervalMs;

    if (this.enabled) {
      this.loadHistory();
      console.log(
        `[ListingMonitor] Инициализирован. Известно монет: ${this.knownCoins.size}, ` +
        `уведомлено: ${this.notifiedCoins.size}, проверка каждые ${checkIntervalMs / 1000}s`
      );
    }
  }

  /**
   * Загрузить историю известных монет и уведомлений из файла.
   */
  private loadHistory(): void {
    try {
      if (fs.existsSync(this.historyFilePath)) {
        const data = fs.readFileSync(this.historyFilePath, 'utf-8');
        const history = JSON.parse(data);
        
        if (Array.isArray(history.knownCoins)) {
          this.knownCoins = new Set(history.knownCoins);
        }
        
        if (Array.isArray(history.notifiedCoins)) {
          this.notifiedCoins = new Set(history.notifiedCoins);
        }

        if (config.logLevel === 'debug') {
          console.log(
            `[ListingMonitor] История загружена: ${this.knownCoins.size} известных монет, ` +
            `${this.notifiedCoins.size} уведомлений отправлено`
          );
        }
      }
    } catch (err) {
      console.warn('[ListingMonitor] Не удалось загрузить историю листингов:', err);
    }
  }

  /**
   * Сохранить историю известных монет и уведомлений в файл.
   */
  private saveHistory(): void {
    try {
      const dir = path.dirname(this.historyFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const history = {
        knownCoins: Array.from(this.knownCoins),
        notifiedCoins: Array.from(this.notifiedCoins),
        lastUpdate: new Date().toISOString(),
      };

      fs.writeFileSync(this.historyFilePath, JSON.stringify(history, null, 2), 'utf-8');

      if (config.logLevel === 'debug') {
        console.log('[ListingMonitor] История сохранена');
      }
    } catch (err) {
      console.error('[ListingMonitor] Ошибка при сохранении истории:', err);
    }
  }

  /**
   * Проверить, нужно ли выполнять проверку сейчас (на основе интервала).
   */
  shouldCheck(): boolean {
    const now = Date.now();
    if (now - this.lastCheckTime >= this.checkIntervalMs) {
      this.lastCheckTime = now;
      return true;
    }
    return false;
  }

  /**
   * Обработать текущий список монет и детектировать новые листинги.
   * Возвращает список новых монет, о которых ещё не было отправлено уведомление.
   */
  processCoins(currentCoins: string[]): ListingInfo[] {
    if (!this.enabled) {
      return [];
    }

    const newListings: ListingInfo[] = [];
    const currentCoinsSet = new Set(currentCoins);
    const now = new Date();

    // Первый запуск - инициализируем список известных монет
    if (this.knownCoins.size === 0) {
      console.log(`[ListingMonitor] Первый запуск, инициализируем список из ${currentCoins.length} монет`);
      this.knownCoins = new Set(currentCoins);
      this.notifiedCoins = new Set(currentCoins); // Не отправляем уведомления при первом запуске
      this.saveHistory();
      return [];
    }

    // Ищем новые монеты
    for (const coin of currentCoins) {
      if (!this.knownCoins.has(coin)) {
        console.log(`[ListingMonitor] 🆕 Обнаружена новая монета: ${coin}`);
        
        const listing: ListingInfo = {
          coin,
          detectedAt: now,
        };

        // Добавляем в известные монеты
        this.knownCoins.add(coin);

        // Если ещё не отправляли уведомление - добавляем в список
        if (!this.notifiedCoins.has(coin)) {
          newListings.push(listing);
        }
      }
    }

    // Сохраняем обновлённую историю
    if (newListings.length > 0) {
      this.saveHistory();
    }

    return newListings;
  }

  /**
   * Отметить монету как уведомлённую (уведомление отправлено).
   */
  markAsNotified(coin: string): void {
    if (!this.notifiedCoins.has(coin)) {
      this.notifiedCoins.add(coin);
      this.saveHistory();
      
      if (config.logLevel === 'debug') {
        console.log(`[ListingMonitor] Монета ${coin} отмечена как уведомлённая`);
      }
    }
  }

  /**
   * Получить список всех известных монет.
   */
  getKnownCoins(): string[] {
    return Array.from(this.knownCoins);
  }

  /**
   * Получить список монет, о которых отправлены уведомления.
   */
  getNotifiedCoins(): string[] {
    return Array.from(this.notifiedCoins);
  }

  /**
   * Сбросить историю (для тестирования или ручного сброса).
   */
  resetHistory(): void {
    this.knownCoins.clear();
    this.notifiedCoins.clear();
    this.saveHistory();
    console.log('[ListingMonitor] История сброшена');
  }

  /**
   * Форматировать сообщение о новом листинге для Telegram.
   */
  formatListingMessage(listings: ListingInfo[]): string {
    if (listings.length === 0) {
      return '';
    }

    const now = new Date();
    const timestamp = now.toLocaleString('ru-RU', { 
      timeZone: 'UTC',
      hour12: false,
    });

    if (listings.length === 1) {
      const listing = listings[0];
      return (
        `🆕 <b>Новый листинг на Hyperliquid!</b>\n\n` +
        `💎 Монета: <b>${listing.coin}</b>\n` +
        `⏰ Обнаружено: ${timestamp} UTC\n\n` +
        `🔍 Начинаем мониторинг плотностей...`
      );
    } else {
      const coinsList = listings.map(l => `• <b>${l.coin}</b>`).join('\n');
      return (
        `🆕 <b>Новые листинги на Hyperliquid!</b>\n\n` +
        `💎 Монеты (${listings.length}):\n${coinsList}\n\n` +
        `⏰ Обнаружено: ${timestamp} UTC\n` +
        `🔍 Начинаем мониторинг плотностей...`
      );
    }
  }
}


import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';

/**
 * Идентификатор якоря (уникальная комбинация монеты, цены и стороны).
 */
export interface AnchorId {
  coin: string;
  anchorPrice: number;
  side: 'bid' | 'ask';
}

/**
 * Статистика по якорю.
 */
export interface AnchorStats {
  anchorId: AnchorId;
  
  // Счётчики сделок
  totalTrades: number;      // Всего сделок от этого якоря
  winTrades: number;        // Профитных сделок
  lossTrades: number;       // Убыточных сделок
  
  // Временные метки
  firstTradeAt: number;     // Первая сделка
  lastTradeAt: number;      // Последняя сделка
  
  // PnL
  totalPnlUsd: number;      // Суммарный PnL в USD
  avgPnlPercent: number;    // Средний PnL в %
  
  // Дополнительная информация
  lastTradeSize: number;    // Размер последней сделки в USD
}

/**
 * Сервис для хранения и управления статистикой по якорям.
 */
export class AnchorMemory {
  private anchors = new Map<string, AnchorStats>();
  private readonly storageFilePath: string;
  private readonly enabled: boolean;
  
  constructor(storageFilePath: string = './data/anchor_memory.json', enabled: boolean = true) {
    this.storageFilePath = storageFilePath;
    this.enabled = enabled;
    
    if (this.enabled) {
      this.loadFromDisk();
    }
  }
  
  /**
   * Создать строковый ключ из AnchorId.
   */
  private getAnchorKey(anchorId: AnchorId): string {
    // Округляем цену до 4 знаков для группировки близких цен
    const roundedPrice = Math.round(anchorId.anchorPrice * 10000) / 10000;
    return `${anchorId.coin}:${roundedPrice}:${anchorId.side}`;
  }
  
  /**
   * Получить статистику по якорю.
   */
  getStats(anchorId: AnchorId): AnchorStats | null {
    if (!this.enabled) {
      return null;
    }
    
    const key = this.getAnchorKey(anchorId);
    return this.anchors.get(key) || null;
  }
  
  /**
   * Записать завершённую сделку по якорю.
   */
  recordTrade(
    anchorId: AnchorId,
    pnlUsd: number,
    pnlPercent: number,
    sizeUsd: number
  ): void {
    if (!this.enabled) {
      return;
    }
    
    const key = this.getAnchorKey(anchorId);
    const now = Date.now();
    
    let stats = this.anchors.get(key);
    
    if (!stats) {
      // Создаём новую запись
      stats = {
        anchorId,
        totalTrades: 0,
        winTrades: 0,
        lossTrades: 0,
        firstTradeAt: now,
        lastTradeAt: now,
        totalPnlUsd: 0,
        avgPnlPercent: 0,
        lastTradeSize: sizeUsd,
      };
      this.anchors.set(key, stats);
    }
    
    // Обновляем статистику
    stats.totalTrades++;
    stats.lastTradeAt = now;
    stats.lastTradeSize = sizeUsd;
    stats.totalPnlUsd += pnlUsd;
    
    if (pnlUsd > 0) {
      stats.winTrades++;
    } else if (pnlUsd < 0) {
      stats.lossTrades++;
    }
    
    // Обновляем средний PnL%
    const prevTotal = stats.avgPnlPercent * (stats.totalTrades - 1);
    stats.avgPnlPercent = (prevTotal + pnlPercent) / stats.totalTrades;
    
    // Сохраняем на диск
    this.saveToDisk();
    
    if (config.logLevel === 'debug') {
      console.log(
        `[AnchorMemory] Записана сделка по якорю ${key}: ` +
        `PnL=${pnlUsd.toFixed(2)}$ (${pnlPercent.toFixed(2)}%), ` +
        `всего сделок=${stats.totalTrades}, винов=${stats.winTrades}`
      );
    }
  }
  
  /**
   * Проверить, можно ли торговать от этого якоря (не превышен лимит винов).
   */
  canTrade(anchorId: AnchorId, maxWins: number): boolean {
    if (!this.enabled) {
      return true;
    }
    
    const stats = this.getStats(anchorId);
    if (!stats) {
      return true; // Нет истории - можно торговать
    }
    
    return stats.winTrades < maxWins;
  }
  
  /**
   * Получить количество минут с последней сделки по якорю.
   */
  getMinutesSinceLastTrade(anchorId: AnchorId): number {
    const stats = this.getStats(anchorId);
    if (!stats) {
      return Infinity; // Никогда не торговали
    }
    
    const now = Date.now();
    const diffMs = now - stats.lastTradeAt;
    return diffMs / 1000 / 60;
  }
  
  /**
   * Загрузить статистику с диска.
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storageFilePath)) {
        const data = fs.readFileSync(this.storageFilePath, 'utf-8');
        const parsed = JSON.parse(data);
        
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const key = this.getAnchorKey(entry.anchorId);
            this.anchors.set(key, entry);
          }
          
          console.log(`[AnchorMemory] Загружено ${this.anchors.size} якорей из ${this.storageFilePath}`);
        }
      }
    } catch (err) {
      console.warn('[AnchorMemory] Не удалось загрузить статистику якорей:', err);
    }
  }
  
  /**
   * Сохранить статистику на диск.
   */
  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.storageFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      const data = Array.from(this.anchors.values());
      fs.writeFileSync(this.storageFilePath, JSON.stringify(data, null, 2), 'utf-8');
      
      if (config.logLevel === 'debug') {
        console.log(`[AnchorMemory] Статистика сохранена (${data.length} якорей)`);
      }
    } catch (err) {
      console.error('[AnchorMemory] Ошибка при сохранении статистики:', err);
    }
  }
  
  /**
   * Получить все якоря (для отладки/анализа).
   */
  getAllAnchors(): AnchorStats[] {
    return Array.from(this.anchors.values());
  }
  
  /**
   * Очистить статистику по якорю.
   */
  clearAnchor(anchorId: AnchorId): void {
    const key = this.getAnchorKey(anchorId);
    this.anchors.delete(key);
    this.saveToDisk();
  }
  
  /**
   * Очистить всю статистику.
   */
  clearAll(): void {
    this.anchors.clear();
    this.saveToDisk();
    console.log('[AnchorMemory] Вся статистика очищена');
  }
}


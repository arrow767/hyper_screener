import { config } from '../config';

/**
 * История изменений NATR для расчёта "шока".
 */
interface NatrHistoryEntry {
  timestamp: number;
  natr: number;
}

/**
 * Контекстные фичи для принятия решений о размере позиции и TP/SL.
 */
export interface ContextFeatures {
  // Шок по NATR (суммарное движение за период)
  shock30mNatr: number;  // Сколько NATR прошли за 30 минут
  shock60mNatr: number;  // Сколько NATR прошли за 60 минут
  
  // Время в зоне якоря (для открытых позиций)
  timeInAnchorZoneMin: number;  // Минуты возле якорной цены
  timeSinceEntryMin: number;    // Минуты с момента входа
  
  // Статистика по якорю
  anchorTradeCount: number;  // Количество завершённых сделок по якорю
  anchorWinCount: number;    // Количество профитных сделок по якорю
  anchorLastTradeAgoMin: number;  // Минут с последней сделки по якорю
  
  // Счётчики TP
  tpHitsCount: number;  // Сколько TP уже достигнуто
}

/**
 * Сервис для расчёта контекстных фичей.
 */
export class ContextFeaturesService {
  private natrHistory = new Map<string, NatrHistoryEntry[]>();
  private readonly maxHistoryAgeMs = 3600000; // 1 час
  
  /**
   * Обновить историю NATR для монеты.
   */
  updateNatrHistory(coin: string, natr: number): void {
    const now = Date.now();
    
    if (!this.natrHistory.has(coin)) {
      this.natrHistory.set(coin, []);
    }
    
    const history = this.natrHistory.get(coin)!;
    
    // Добавляем новую запись
    history.push({ timestamp: now, natr });
    
    // Удаляем старые записи (старше 1 часа)
    const cutoffTime = now - this.maxHistoryAgeMs;
    while (history.length > 0 && history[0].timestamp < cutoffTime) {
      history.shift();
    }
  }
  
  /**
   * Расчитать "шок" по NATR - суммарное изменение за период.
   */
  calculateNatrShock(coin: string, windowMs: number): number {
    const history = this.natrHistory.get(coin);
    if (!history || history.length < 2) {
      return 0;
    }
    
    const now = Date.now();
    const cutoffTime = now - windowMs;
    
    // Фильтруем записи в пределах окна
    const windowHistory = history.filter(entry => entry.timestamp >= cutoffTime);
    
    if (windowHistory.length < 2) {
      return 0;
    }
    
    // Суммируем абсолютные изменения NATR
    let totalShock = 0;
    for (let i = 1; i < windowHistory.length; i++) {
      const diff = Math.abs(windowHistory[i].natr - windowHistory[i - 1].natr);
      totalShock += diff;
    }
    
    return totalShock;
  }
  
  /**
   * Получить текущий NATR для монеты (последнее значение).
   */
  getCurrentNatr(coin: string): number | null {
    const history = this.natrHistory.get(coin);
    if (!history || history.length === 0) {
      return null;
    }
    return history[history.length - 1].natr;
  }
  
  /**
   * Расчитать время в зоне якоря (сколько цена находится близко к якорной цене).
   */
  calculateTimeInAnchorZone(
    currentPrice: number,
    anchorPrice: number,
    entryTime: number,
    natrPercent: number
  ): number {
    const now = Date.now();
    const totalTimeMin = (now - entryTime) / 1000 / 60;
    
    // Определяем, находимся ли мы в зоне якоря (±1 NATR)
    const distancePercent = Math.abs((currentPrice - anchorPrice) / anchorPrice) * 100;
    const anchorZoneThreshold = natrPercent; // ±1 NATR
    
    // Упрощённая логика: если мы сейчас в зоне, возвращаем всё время
    // В более сложной реализации нужно отслеживать историю цен
    if (distancePercent <= anchorZoneThreshold) {
      return totalTimeMin;
    }
    
    return 0;
  }
  
  /**
   * Очистить историю для конкретной монеты.
   */
  clearHistory(coin: string): void {
    this.natrHistory.delete(coin);
  }
  
  /**
   * Очистить всю историю.
   */
  clearAllHistory(): void {
    this.natrHistory.clear();
  }
}


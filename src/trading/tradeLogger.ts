import * as fs from 'fs';
import * as path from 'path';
import { PositionState } from './interfaces';

/**
 * Запись о закрытой сделке для CSV лога.
 */
export interface TradeLogEntry {
  // Идентификация
  tradeId: string;
  coin: string;
  side: 'long' | 'short';
  
  // Время
  openedAt: Date;
  closedAt: Date;
  durationSeconds: number;
  durationMinutes: number;
  
  // Цены и объём
  entryPrice: number;
  exitPrice: number;
  sizeUsd: number;
  
  // Результаты
  pnlUsd: number;
  pnlPercent: number;
  
  // Комиссии (если известны)
  entryFeeUsd?: number;
  exitFeeUsd?: number;
  totalFeeUsd?: number;
  
  // Метрики
  natr?: number;
  maxDrawdownPercent?: number;
  
  // Контекст
  closeReason: string;
  entryMode: 'market' | 'limit' | 'mixed';
  signalSource: string;
  
  // Дополнительно
  limitOrdersUsed: number;
  tpLevelsHit: number;
}

/**
 * Класс для логирования сделок в CSV файл.
 */
export class TradeLogger {
  private readonly logDir: string;
  private readonly enabled: boolean;
  
  constructor(logDir: string = './trade_logs', enabled: boolean = true) {
    this.logDir = logDir;
    this.enabled = enabled;
    
    if (this.enabled) {
      this.ensureLogDirectory();
    }
  }
  
  /**
   * Создаёт директорию для логов, если она не существует.
   */
  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
        console.log(`[TradeLogger] Создана директория для логов: ${this.logDir}`);
      }
    } catch (err) {
      console.error('[TradeLogger] Ошибка при создании директории для логов:', err);
    }
  }
  
  /**
   * Получить путь к файлу лога за конкретный день.
   */
  private getLogFilePath(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const filename = `trades_${year}-${month}-${day}.csv`;
    return path.join(this.logDir, filename);
  }
  
  /**
   * Проверить, существует ли файл и содержит ли он заголовок.
   */
  private fileHasHeader(filepath: string): boolean {
    try {
      if (!fs.existsSync(filepath)) {
        return false;
      }
      const content = fs.readFileSync(filepath, 'utf-8');
      return content.length > 0 && content.includes('tradeId');
    } catch {
      return false;
    }
  }
  
  /**
   * Записать заголовок CSV файла.
   */
  private writeHeader(filepath: string): void {
    const header = [
      'tradeId',
      'coin',
      'side',
      'openedAt',
      'closedAt',
      'durationSeconds',
      'durationMinutes',
      'entryPrice',
      'exitPrice',
      'sizeUsd',
      'pnlUsd',
      'pnlPercent',
      'entryFeeUsd',
      'exitFeeUsd',
      'totalFeeUsd',
      'natr',
      'maxDrawdownPercent',
      'closeReason',
      'entryMode',
      'signalSource',
      'limitOrdersUsed',
      'tpLevelsHit',
    ].join(',');
    
    fs.writeFileSync(filepath, header + '\n', 'utf-8');
  }
  
  /**
   * Форматировать значение для CSV (экранирование запятых и кавычек).
   */
  private formatCsvValue(value: any): string {
    if (value === null || value === undefined) {
      return '';
    }
    
    const str = String(value);
    
    // Если содержит запятую, кавычки или перевод строки - оборачиваем в кавычки
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    
    return str;
  }
  
  /**
   * Форматировать дату в ISO формат для CSV.
   */
  private formatDate(date: Date): string {
    return date.toISOString();
  }
  
  /**
   * Записать сделку в CSV файл.
   */
  logTrade(entry: TradeLogEntry): void {
    if (!this.enabled) {
      return;
    }
    
    try {
      const filepath = this.getLogFilePath(entry.closedAt);
      
      // Если файл не существует или не имеет заголовка, создаём его
      if (!this.fileHasHeader(filepath)) {
        this.writeHeader(filepath);
      }
      
      // Формируем строку CSV
      const row = [
        this.formatCsvValue(entry.tradeId),
        this.formatCsvValue(entry.coin),
        this.formatCsvValue(entry.side),
        this.formatCsvValue(this.formatDate(entry.openedAt)),
        this.formatCsvValue(this.formatDate(entry.closedAt)),
        this.formatCsvValue(entry.durationSeconds),
        this.formatCsvValue(entry.durationMinutes.toFixed(2)),
        this.formatCsvValue(entry.entryPrice.toFixed(6)),
        this.formatCsvValue(entry.exitPrice.toFixed(6)),
        this.formatCsvValue(entry.sizeUsd.toFixed(2)),
        this.formatCsvValue(entry.pnlUsd.toFixed(2)),
        this.formatCsvValue(entry.pnlPercent.toFixed(2)),
        this.formatCsvValue(entry.entryFeeUsd?.toFixed(2) || ''),
        this.formatCsvValue(entry.exitFeeUsd?.toFixed(2) || ''),
        this.formatCsvValue(entry.totalFeeUsd?.toFixed(2) || ''),
        this.formatCsvValue(entry.natr?.toFixed(3) || ''),
        this.formatCsvValue(entry.maxDrawdownPercent?.toFixed(2) || ''),
        this.formatCsvValue(entry.closeReason),
        this.formatCsvValue(entry.entryMode),
        this.formatCsvValue(entry.signalSource),
        this.formatCsvValue(entry.limitOrdersUsed),
        this.formatCsvValue(entry.tpLevelsHit),
      ].join(',');
      
      // Дописываем в файл
      fs.appendFileSync(filepath, row + '\n', 'utf-8');
      
      console.log(
        `[TradeLogger] 📊 Сделка записана: ${entry.coin} ${entry.side.toUpperCase()} ` +
        `PnL=${entry.pnlUsd.toFixed(2)}$ (${entry.pnlPercent.toFixed(2)}%), ` +
        `duration=${entry.durationMinutes.toFixed(1)}m → ${filepath}`
      );
    } catch (err) {
      console.error('[TradeLogger] Ошибка при записи сделки в CSV:', err);
    }
  }
  
  /**
   * Создать запись лога из позиции при её закрытии.
   */
  createLogEntry(
    position: PositionState,
    exitPrice: number,
    closeReason: string,
    natr?: number
  ): TradeLogEntry {
    const openedAt = new Date(position.openedAt);
    const closedAt = new Date();
    const durationMs = closedAt.getTime() - openedAt.getTime();
    const durationSeconds = Math.round(durationMs / 1000);
    const durationMinutes = durationMs / 1000 / 60;
    
    // Расчёт фактического размера позиции на момент закрытия
    // Учитываем частичные закрытия по TP лимиткам
    let currentSizeUsd = position.sizeUsd;
    if (position.tpLimitOrders && position.tpLimitOrders.length > 0) {
      const closedByTp = position.tpLimitOrders
        .filter(o => o.filled)
        .reduce((sum, o) => sum + o.sizeUsd, 0);
      currentSizeUsd = position.sizeUsd - closedByTp;
    }
    
    // Расчёт PnL (правильная формула для long и short)
    const priceDiff = position.side === 'long'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
    const pnlPercent = (priceDiff / position.entryPrice) * 100;
    
    // PnL рассчитывается от фактического размера позиции на момент выхода
    const pnlUsd = (currentSizeUsd * pnlPercent) / 100;
    
    // Расчёт комиссий (приблизительно, если нет точных данных от биржи)
    // Binance Futures: maker 0.02%, taker 0.04%
    // Hyperliquid: maker 0.00%, taker 0.035%
    // Используем консервативную оценку: entry taker 0.04%, exit может быть maker 0.02% или taker 0.04%
    const entryFeeUsd = position.sizeUsd * 0.0004; // 0.04% на вход
    const exitFeeUsd = currentSizeUsd * 0.0004;  // 0.04% на выход (консервативно)
    const totalFeeUsd = entryFeeUsd + exitFeeUsd;
    
    // Подсчёт использованных лимитных ордеров
    const limitOrdersUsed = 
      (position.entryLimitOrders?.filter(o => o.filled).length || 0) +
      (position.tpLimitOrders?.filter(o => o.filled).length || 0);
    
    // Подсчёт достигнутых TP уровней
    const tpLevelsHit = position.tpTargets?.filter(t => t.hit).length || 0;
    
    // Определяем режим входа
    let entryMode: 'market' | 'limit' | 'mixed' = 'market';
    if (position.marketFilledSizeUsd && position.limitFilledSizeUsd) {
      entryMode = 'mixed';
    } else if (position.limitFilledSizeUsd && position.limitFilledSizeUsd > 0) {
      entryMode = 'limit';
    }
    
    return {
      tradeId: position.id,
      coin: position.coin,
      side: position.side,
      openedAt,
      closedAt,
      durationSeconds,
      durationMinutes,
      entryPrice: position.entryPrice,
      exitPrice,
      sizeUsd: position.sizeUsd, // Изначальный размер
      pnlUsd,
      pnlPercent,
      entryFeeUsd,
      exitFeeUsd,
      totalFeeUsd,
      natr,
      closeReason,
      entryMode,
      signalSource: 'liquidity', // В текущей реализации всегда liquidity
      limitOrdersUsed,
      tpLevelsHit,
    };
  }
}


/**
 * File Logger with Rotation
 * - Logs to daily files in logs/ directory
 * - Auto-rotates when file exceeds 5MB
 * - Cleanup old files (keeps last 20)
 */

import * as fs from 'fs';
import * as path from 'path';

export class FileLogger {
  private logDir: string;
  private currentFile: string | null = null;
  private maxFileSize = 5 * 1024 * 1024; // 5MB
  private maxFiles = 20;

  constructor(logDir = './logs') {
    this.logDir = logDir;
    this.ensureLogDir();
    this.cleanupOldLogs();
  }

  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private getLogFileName(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    
    // Если файл не существует или превышает лимит, создаём новый
    if (this.currentFile) {
      const filePath = path.join(this.logDir, this.currentFile);
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size < this.maxFileSize) {
          return this.currentFile; // Используем текущий файл
        }
      }
    }

    // Создаём новый файл с timestamp
    this.currentFile = `trading_${dateStr}_${timeStr}.log`;
    return this.currentFile;
  }

  private cleanupOldLogs(): void {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('trading_') && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          mtime: fs.statSync(path.join(this.logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime); // Сортируем по времени (новые первые)

      // Удаляем файлы старше maxFiles
      if (files.length > this.maxFiles) {
        const toDelete = files.slice(this.maxFiles);
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          console.log(`[FileLogger] Удалён старый лог: ${file.name}`);
        }
      }
    } catch (err) {
      console.error('[FileLogger] Ошибка при очистке логов:', err);
    }
  }

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string, data?: any): void {
    try {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        level,
        message,
        ...(data && { data })
      };

      const logLine = JSON.stringify(logEntry) + '\n';
      const fileName = this.getLogFileName();
      const filePath = path.join(this.logDir, fileName);

      fs.appendFileSync(filePath, logLine);

      // Также выводим в консоль
      const prefix = `[${level}] [${timestamp}]`;
      if (level === 'ERROR') {
        console.error(prefix, message, data || '');
      } else if (level === 'WARN') {
        console.warn(prefix, message, data || '');
      } else {
        console.log(prefix, message, data || '');
      }

      // Проверяем размер файла после записи
      const stats = fs.statSync(filePath);
      if (stats.size >= this.maxFileSize) {
        this.currentFile = null; // Сбрасываем, чтобы создать новый файл
      }
    } catch (err) {
      console.error('[FileLogger] Ошибка записи в лог:', err);
    }
  }

  info(message: string, data?: any): void {
    this.log('INFO', message, data);
  }

  warn(message: string, data?: any): void {
    this.log('WARN', message, data);
  }

  error(message: string, data?: any): void {
    this.log('ERROR', message, data);
  }

  debug(message: string, data?: any): void {
    this.log('DEBUG', message, data);
  }
}

// Singleton instance
export const fileLogger = new FileLogger();


export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Инкрементальный расчёт ATR и NATR по методике Wilder.
 * NATR = ATR / close * 100.
 */
class NatrCalculator {
  private readonly period: number;
  private trHistory: number[] = [];
  private lastClose: number | null = null;
  private atr: number | null = null;

  constructor(period: number) {
    this.period = period;
  }

  update(candle: Candle): number | null {
    const { high, low, close } = candle;

    let tr: number;
    if (this.lastClose == null) {
      tr = high - low;
    } else {
      const hl = high - low;
      const hc = Math.abs(high - this.lastClose);
      const lc = Math.abs(low - this.lastClose);
      tr = Math.max(hl, hc, lc);
    }

    this.lastClose = close;

    if (this.atr == null) {
      // Накапливаем первые period TR для стартового ATR
      this.trHistory.push(tr);
      if (this.trHistory.length < this.period) {
        return null;
      }
      const sum = this.trHistory.reduce((acc, v) => acc + v, 0);
      this.atr = sum / this.period;
    } else {
      // Wilder smoothing: ATR_t = (ATR_{t-1} * (n-1) + TR_t) / n
      this.atr = ((this.atr * (this.period - 1)) + tr) / this.period;
    }

    if (!isFinite(this.atr) || this.atr <= 0 || close <= 0) {
      return null;
    }

    const natr = (this.atr / close) * 100;
    return isFinite(natr) && natr > 0 ? natr : null;
  }

  getCurrentNatr(): number | null {
    if (this.atr == null || this.lastClose == null || this.lastClose <= 0) {
      return null;
    }
    const natr = (this.atr / this.lastClose) * 100;
    return isFinite(natr) && natr > 0 ? natr : null;
  }
}

/**
 * NatrService — менеджер NATR по монетам.
 * Источник свечей будет подключён позже; сейчас это чистая логика.
 */
export class NatrService {
  private readonly period: number;
  private calculators = new Map<string, NatrCalculator>();

  constructor(period: number) {
    this.period = period;
  }

  /**
   * Обновить NATR по монете новой свечой.
   * Возвращает актуальный NATR или null, если ещё не достаточно данных.
   */
  update(coin: string, candle: Candle): number | null {
    const key = coin.toUpperCase();
    let calc = this.calculators.get(key);
    if (!calc) {
      calc = new NatrCalculator(this.period);
      this.calculators.set(key, calc);
    }
    return calc.update(candle);
  }

  /**
   * Получить текущий NATR для монеты (если уже прогрет).
   */
  getNatr(coin: string): number | null {
    const calc = this.calculators.get(coin.toUpperCase());
    return calc ? calc.getCurrentNatr() : null;
  }
}



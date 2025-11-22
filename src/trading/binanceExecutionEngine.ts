import crypto from 'crypto';
import fetch from 'node-fetch';
import { ExecutionEngine, PositionState, TradeSignal, LimitOrderState } from './interfaces';
import { config } from '../config';

interface BinanceOrderResponse {
  orderId: number;
  clientOrderId: string;
}

/**
 * ExecutionEngine для Binance USDT‑фьючерсов (Futures API).
 *
 * ВАЖНО:
 * - Этот движок считается "боевым" ТОЛЬКО при TRADE_MODE=TRADE_LIVE и TRADE_EXECUTION_VENUE=BINANCE.
 * - Использует ключи из .env: BINANCE_API_KEY, BINANCE_API_SECRET.
 * - Ты сам решаешь, когда включать live-режим. По умолчанию всё безопасно через PAPER.
 */
export class BinanceExecutionEngine implements ExecutionEngine {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private exchangeInfoCache: any | null = null;

  constructor() {
    const key = process.env.BINANCE_API_KEY;
    const secret = process.env.BINANCE_API_SECRET;

    if (!key || !secret) {
      console.warn(
        '[BinanceExecution] BINANCE_API_KEY или BINANCE_API_SECRET не заданы — движок будет работать как заглушка.'
      );
    }

    this.apiKey = key || '';
    this.apiSecret = secret || '';
    // По умолчанию USDT‑perps (futures); можно вынести в конфиг при необходимости
    this.baseUrl = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
  }

  private isLive(): boolean {
    return !!this.apiKey && !!this.apiSecret && config.tradeMode === 'TRADE_LIVE';
  }

  private sign(query: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  private async callBinance(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number>
  ): Promise<any> {
    const timestamp = Date.now();
    const baseParams = { ...params, timestamp, recvWindow: 5000 };

    const query = Object.entries(baseParams)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');

    const signature = this.sign(query);
    const url = `${this.baseUrl}${path}?${query}&signature=${signature}`;

    const res = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    });

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`[BinanceExecution] Failed to parse JSON response: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`[BinanceExecution] Error ${res.status}: ${JSON.stringify(json)}`);
    }

    return json;
  }

  private async ensureExchangeInfo(): Promise<void> {
    if (this.exchangeInfoCache) return;
    try {
      this.exchangeInfoCache = await this.callBinance('GET', '/fapi/v1/exchangeInfo', {});
      if (config.logLevel === 'debug') {
        console.log('[BinanceExecution] exchangeInfo loaded');
      }
    } catch (error) {
      console.error('[BinanceExecution] Failed to load exchangeInfo:', error);
      this.exchangeInfoCache = null;
    }
  }

  /**
   * Нормализация цены по правилам биржи (tickSize из PRICE_FILTER).
   * @param symbol - символ инструмента (например, BTCUSDT)
   * @param priceRaw - исходная цена
   * @returns Округлённая цена с правильной точностью
   */
  private async normalizePrice(symbol: string, priceRaw: number): Promise<number> {
    await this.ensureExchangeInfo();
    
    if (!this.exchangeInfoCache) {
      return Number(priceRaw.toFixed(2));
    }

    const info = this.exchangeInfoCache.symbols?.find((s: any) => s.symbol === symbol);
    if (!info) {
      return Number(priceRaw.toFixed(2));
    }

    const priceFilter = info.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
    if (!priceFilter) {
      return Number(priceRaw.toFixed(2));
    }

    const tickSize = parseFloat(priceFilter.tickSize);
    if (!isFinite(tickSize) || tickSize <= 0) {
      return Number(priceRaw.toFixed(2));
    }

    // Округляем к ближайшему шагу (tickSize)
    const price = Math.round(priceRaw / tickSize) * tickSize;
    
    // Определяем количество знаков после запятой для tickSize
    const tickStr = tickSize.toString();
    const decimals = tickStr.includes('.') ? tickStr.split('.')[1].length : 0;
    
    return Number(price.toFixed(decimals));
  }

  /**
   * Получить LOT_SIZE для символа (минимальный шаг количества).
   * Пример: BTC = 0.001, ETH = 0.01, SHIB = 1000
   */
  private async getLotSize(symbol: string): Promise<number> {
    await this.ensureExchangeInfo();
    
    if (!this.exchangeInfoCache) {
      return 0.001; // default
    }

    const info = this.exchangeInfoCache.symbols?.find((s: any) => s.symbol === symbol);
    if (!info) {
      return 0.001;
    }

    const lotSizeFilter = info.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    if (!lotSizeFilter) {
      return 0.001;
    }

    const stepSize = parseFloat(lotSizeFilter.stepSize);
    return isFinite(stepSize) && stepSize > 0 ? stepSize : 0.001;
  }

  /**
   * Нормализовать количество (contracts) к валидному значению согласно LOT_SIZE биржи.
   * Округляет вниз до ближайшего кратного LOT_SIZE.
   */
  private async normalizeQuantity(symbol: string, quantityRaw: number): Promise<number> {
    const lotSize = await this.getLotSize(symbol);
    
    // Округляем вниз до ближайшего кратного lotSize
    const quantity = Math.floor(quantityRaw / lotSize) * lotSize;
    
    // Определяем количество знаков после запятой для lotSize
    const lotStr = lotSize.toString();
    const decimals = lotStr.includes('.') ? lotStr.split('.')[1].length : 0;
    
    return Number(quantity.toFixed(decimals));
  }

  /**
   * Получить реальные trades (исполнения) для ордера с Binance.
   * Возвращает массив trades с ценами, комиссиями и т.д.
   */
  private async getOrderTrades(symbol: string, orderId: number): Promise<any[]> {
    if (!this.isLive()) {
      return [];
    }

    try {
      const trades = await this.callBinance('GET', '/fapi/v1/userTrades', {
        symbol,
        orderId,
      });
      return Array.isArray(trades) ? trades : [];
    } catch (error) {
      console.error(`[BinanceExecution] Failed to get trades for order ${orderId}:`, error);
      return [];
    }
  }

  /**
   * Конвертация монеты в Binance futures symbol.
   * Пример: BTC -> BTCUSDT.
   */
  private toSymbol(coin: string): string {
    return `${coin.toUpperCase()}USDT`;
  }

  async openPosition(signal: TradeSignal): Promise<PositionState | null> {
    if (!this.isLive()) {
      console.warn(
        `[BinanceExecution] LIVE trading disabled (mode=${config.tradeMode}, keys=${this.apiKey ? 'set' : 'missing'}). ` +
          `Запрос на открытие ${signal.side.toUpperCase()} ${signal.coin} sizeUsd=${signal.targetPositionSizeUsd} будет только залогирован.`
      );
      return null;
    }

    const symbol = this.toSymbol(signal.coin);
    const side = signal.side === 'long' ? 'BUY' : 'SELL';

    const price = signal.referencePrice;
    if (!isFinite(price) || price <= 0) {
      console.error('[BinanceExecution] Invalid referencePrice for openPosition:', price);
      return null;
    }

    // Грубая оценка количества: qty = USD / price, затем нормализуем под lotSize
    const qtyRaw = signal.targetPositionSizeUsd / price;
    if (!isFinite(qtyRaw) || qtyRaw <= 0) {
      console.error('[BinanceExecution] Invalid computed quantity:', qtyRaw);
      return null;
    }

    const quantity = await this.normalizeQuantity(symbol, qtyRaw);
    if (quantity <= 0) {
      return null;
    }

    console.log(
      `[BinanceExecution] Sending MARKET order: ${side} ${symbol} qty=${quantity} (approx ${signal.targetPositionSizeUsd} USD @ $${price.toFixed(
        4
      )})`
    );

    try {
      const resp = (await this.callBinance('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity,
      })) as BinanceOrderResponse;

      const id = `binance-${resp.orderId}`;

      // Получаем реальные trades для точного расчета PnL
      await new Promise(resolve => setTimeout(resolve, 500)); // Даем время на исполнение
      const entryTrades = await this.getOrderTrades(symbol, resp.orderId);

      // Рассчитываем weighted average entry price из реальных trades
      let actualEntryPrice = price;
      let actualSizeUsd = signal.targetPositionSizeUsd;
      let actualSizeContracts = quantity; // Фактическое количество исполненное
      
      if (entryTrades.length > 0) {
        let totalQty = 0;
        let totalCost = 0;
        
        for (const trade of entryTrades) {
          const tradeQty = parseFloat(trade.qty);
          const tradePrice = parseFloat(trade.price);
          totalQty += tradeQty;
          totalCost += tradeQty * tradePrice;
        }
        
        if (totalQty > 0) {
          actualEntryPrice = totalCost / totalQty;
          actualSizeUsd = totalCost;
          actualSizeContracts = totalQty; // Реальное количество из trades
        }

        console.log(
          `[BinanceExecution] Получено ${entryTrades.length} реальных trades для entry. ` +
          `Weighted avg price: $${actualEntryPrice.toFixed(4)}, ` +
          `actual size: $${actualSizeUsd.toFixed(2)}, ` +
          `actual contracts: ${actualSizeContracts}`
        );
      }

      const position: PositionState = {
        id,
        coin: signal.coin,
        side: signal.side,
        entryPrice: actualEntryPrice,
        sizeUsd: actualSizeUsd,
        sizeContracts: actualSizeContracts, // ✅ Сохраняем размер в контрактах
        openedAt: Date.now(),
        entryTrades,
      };

      console.log(
        `[BinanceExecution] Открыта позиция: ${position.side.toUpperCase()} ${position.coin} ` +
          `sizeUsd=${position.sizeUsd.toFixed(2)} @ $${position.entryPrice.toFixed(4)} (orderId=${resp.orderId})`
      );

      return position;
    } catch (error) {
      console.error('[BinanceExecution] Failed to open position:', error);
      return null;
    }
  }

  async closePosition(position: PositionState, reason: string): Promise<void> {
    if (!this.isLive()) {
      console.warn(
        `[BinanceExecution] LIVE trading disabled, closePosition логируется только локально. ` +
          `id=${position.id}, coin=${position.coin}, side=${position.side}, reason=${reason}`
      );
      return;
    }

    const symbol = this.toSymbol(position.coin);
    // Для закрытия позиции по маркету отправляем ордер в противоположную сторону
    const side = position.side === 'long' ? 'SELL' : 'BUY';

    // ========================================
    // КРИТИЧЕСКИ ВАЖНО: Закрываем с запасом 110% + reduceOnly
    // ========================================
    let quantity: number;
    const SAFETY_MARGIN = 1.1; // 10% запас для гарантированного закрытия
    
    if (position.sizeContracts && position.sizeContracts > 0) {
      // Используем contracts с запасом 110%
      // reduceOnly гарантирует что Binance не откроет обратную позицию
      const safeQuantity = position.sizeContracts * SAFETY_MARGIN;
      quantity = await this.normalizeQuantity(symbol, safeQuantity);
      
      console.log(
        `[BinanceExecution] 🎯 Закрываем позицию с запасом 110%: ` +
        `position=${position.sizeContracts.toFixed(4)}, ` +
        `order=${quantity} (reduceOnly гарантирует безопасность)`
      );
    } else {
      // Fallback: рассчитываем из USD с запасом
      const price = position.entryPrice;
      const qtyRaw = (position.sizeUsd / price) * SAFETY_MARGIN;
      quantity = await this.normalizeQuantity(symbol, qtyRaw);
      
      console.warn(
        `[BinanceExecution] ⚠️ sizeContracts недоступен, рассчитываем из USD с запасом 110%: ` +
        `sizeUsd=${position.sizeUsd.toFixed(2)}, order=${quantity}`
      );
    }
    
    if (quantity <= 0) {
      console.error(`[BinanceExecution] Invalid quantity for closePosition: ${quantity}`);
      return;
    }

    console.log(
      `[BinanceExecution] Sending MARKET close order: ${side} ${symbol} qty=${quantity} (reason=${reason})`
    );

    try {
      const resp = (await this.callBinance('POST', '/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity,
        reduceOnly: 'true', // ✅ Защита: не откроет обратную позицию, закроет максимум размер позиции
      })) as BinanceOrderResponse;

      // Получаем реальные trades для точного расчета PnL
      await new Promise(resolve => setTimeout(resolve, 500)); // Даем время на исполнение
      const exitTrades = await this.getOrderTrades(symbol, resp.orderId);

      // Сохраняем exit trades в позицию для расчета PnL
      position.exitTrades = exitTrades;

      let actualClosedQty = 0;
      if (exitTrades.length > 0) {
        let totalQty = 0;
        let totalValue = 0;
        
        for (const trade of exitTrades) {
          const tradeQty = parseFloat(trade.qty);
          const tradePrice = parseFloat(trade.price);
          totalQty += tradeQty;
          totalValue += tradeQty * tradePrice;
        }
        
        actualClosedQty = totalQty;
        const avgExitPrice = totalQty > 0 ? totalValue / totalQty : 0;
        
        console.log(
          `[BinanceExecution] Получено ${exitTrades.length} реальных trades для exit. ` +
          `Weighted avg price: $${avgExitPrice.toFixed(4)}, closed qty: ${actualClosedQty}`
        );
      }

      console.log(
        `[BinanceExecution] ✅ closePosition отправлен: ${position.side.toUpperCase()} ${position.coin} ` +
        `requested=${quantity}, filled=${actualClosedQty || 'checking...'}, reason=${reason}`
      );
      
      // ========================================
      // ПРОВЕРКА: Действительно ли позиция закрыта?
      // ========================================
      await new Promise(resolve => setTimeout(resolve, 1000)); // Даём время на обновление
      
      const remainingPosition = await this.getPositionContracts(position.coin);
      
      if (remainingPosition && remainingPosition.contracts > 0) {
        const remainingUsd = remainingPosition.contracts * remainingPosition.entryPrice;
        
        console.error(
          `[BinanceExecution] ❌ КРИТИЧЕСКАЯ ОШИБКА: ПОЗИЦИЯ НЕ ЗАКРЫТА! ` +
          `Осталось: ${remainingPosition.contracts} contracts ($${remainingUsd.toFixed(2)}). ` +
          `Это НЕ должно происходить с запасом 110% + reduceOnly!`
        );
        
        // Экстренный cleanup с ещё большим запасом
        console.log(
          `[BinanceExecution] 🚨 ЭКСТРЕННОЕ ЗАКРЫТИЕ остатка с запасом 120%`
        );
        
        try {
          const emergencyQty = await this.normalizeQuantity(symbol, remainingPosition.contracts * 1.2);
          
          const cleanupResp = (await this.callBinance('POST', '/fapi/v1/order', {
            symbol,
            side,
            type: 'MARKET',
            quantity: emergencyQty,
            reduceOnly: 'true',
          })) as BinanceOrderResponse;
          
          console.log(
            `[BinanceExecution] ✅ Экстренный остаток закрыт (orderId=${cleanupResp.orderId})`
          );
        } catch (cleanupError) {
          console.error(
            `[BinanceExecution] ❌❌❌ НЕ УДАЛОСЬ ЗАКРЫТЬ ОСТАТОК! ТРЕБУЕТСЯ РУЧНОЕ ВМЕШАТЕЛЬСТВО!`,
            cleanupError
          );
        }
      } else {
        console.log(
          `[BinanceExecution] ✅✅✅ Позиция ${position.coin} закрыта ПОЛНОСТЬЮ (запас 110% сработал)`
        );
      }
      
    } catch (error) {
      console.error('[BinanceExecution] ❌ Failed to close position:', error);
      
      // Критическая ошибка - пытаемся получить текущую позицию и залогировать
      try {
        const currentPosition = await this.getPositionContracts(position.coin);
        if (currentPosition) {
          console.error(
            `[BinanceExecution] ❌ Текущая позиция после ошибки: ` +
            `${currentPosition.contracts} contracts ($${currentPosition.sizeUsd.toFixed(2)}). ` +
            `ТРЕБУЕТСЯ РУЧНОЕ ЗАКРЫТИЕ!`
          );
        }
      } catch (checkError) {
        console.error(`[BinanceExecution] Не удалось проверить позицию:`, checkError);
      }
      
      // Пробрасываем ошибку дальше для обработки выше
      throw error;
    }
  }

  async placeLimitOrder(
    coin: string,
    side: 'buy' | 'sell',
    price: number,
    sizeUsd: number,
    purpose: 'entry' | 'tp',
    contracts?: number // ✅ Опциональный параметр - точное количество контрактов
  ): Promise<LimitOrderState | null> {
    if (!this.isLive()) {
      console.warn(
        `[BinanceExecution] LIVE trading disabled, placeLimitOrder для ${coin} ${side} @ $${price.toFixed(4)} только залогирован.`
      );
      return null;
    }

    const symbol = this.toSymbol(coin);
    const binanceSide = side === 'buy' ? 'BUY' : 'SELL';

    if (!isFinite(price) || price <= 0) {
      console.error('[BinanceExecution] Invalid price for placeLimitOrder:', price);
      return null;
    }

    // Используем переданные contracts если есть, иначе рассчитываем из USD
    let quantity: number;
    if (contracts !== undefined && contracts > 0) {
      quantity = await this.normalizeQuantity(symbol, contracts);
    } else {
      const qtyRaw = sizeUsd / price;
      quantity = await this.normalizeQuantity(symbol, qtyRaw);
    }
    
    if (quantity <= 0) {
      return null;
    }

    // Нормализуем цену по правилам биржи
    const normalizedPrice = await this.normalizePrice(symbol, price);

    console.log(
      `[BinanceExecution] Sending LIMIT order: ${binanceSide} ${symbol} qty=${quantity} @ $${normalizedPrice.toFixed(4)} ` +
      `(purpose=${purpose}${contracts ? `, contracts=${contracts}` : ''})`
    );

    try {
      const params: any = {
        symbol,
        side: binanceSide,
        type: 'LIMIT',
        quantity,
        price: normalizedPrice,
        timeInForce: 'GTC',
      };

      // Для TP лимиток устанавливаем reduceOnly
      if (purpose === 'tp') {
        params.reduceOnly = 'true';
      }

      const resp = (await this.callBinance('POST', '/fapi/v1/order', params)) as BinanceOrderResponse;

      const order: LimitOrderState = {
        orderId: `binance-${resp.orderId}`,
        coin,
        price: normalizedPrice,
        sizeUsd,
        contracts: quantity, // ✅ Сохраняем фактическое количество контрактов
        side,
        purpose,
        placedAt: Date.now(),
        filled: false,
        cancelled: false,
      };

      console.log(
        `[BinanceExecution] Лимитный ордер размещён: ${side.toUpperCase()} ${coin} ` +
          `qty=${quantity} contracts ($${sizeUsd.toFixed(2)}) @ $${normalizedPrice.toFixed(4)} (orderId=${resp.orderId})`
      );

      return order;
    } catch (error) {
      console.error('[BinanceExecution] Failed to place limit order:', error);
      return null;
    }
  }

  async cancelLimitOrder(order: LimitOrderState): Promise<void> {
    if (!this.isLive()) {
      console.warn(
        `[BinanceExecution] LIVE trading disabled, cancelLimitOrder для ${order.orderId} только залогирован.`
      );
      return;
    }

    if (order.cancelled || order.filled) {
      if (config.logLevel === 'debug') {
        console.log(
          `[BinanceExecution] Ордер ${order.orderId} уже ${order.cancelled ? 'отменён' : 'заполнен'}, skip cancel`
        );
      }
      return;
    }

    const orderIdMatch = order.orderId.match(/binance-(\d+)/);
    if (!orderIdMatch) {
      console.error(`[BinanceExecution] Invalid orderId format: ${order.orderId}`);
      return;
    }

    const binanceOrderId = parseInt(orderIdMatch[1], 10);
    const symbol = this.toSymbol(order.coin);

    console.log(
      `[BinanceExecution] Отменяем лимитный ордер ${order.orderId}: ${symbol} @ $${order.price.toFixed(4)}`
    );

    try {
      await this.callBinance('DELETE', '/fapi/v1/order', { symbol, orderId: binanceOrderId });

      order.cancelled = true;
      order.cancelledAt = Date.now();

      console.log(`[BinanceExecution] Ордер ${order.orderId} отменён успешно`);
    } catch (error: any) {
      // Ошибки -2011 (Unknown order) и -2013 (Order does not exist) означают,
      // что ордер уже исполнен или отменен - это нормально, не выбрасываем exception
      const errorMsg = error?.message || String(error);
      
      if (errorMsg.includes('-2011') || errorMsg.includes('-2013')) {
        console.log(
          `[BinanceExecution] Ордер ${order.orderId} уже не существует (исполнен или отменен ранее)`
        );
        // Помечаем как отменённый, чтобы больше не пытаться отменить
        order.cancelled = true;
        order.cancelledAt = Date.now();
      } else {
        // Остальные ошибки логируем как серьезные, но не падаем
        console.error(`[BinanceExecution] Failed to cancel order ${order.orderId}:`, error);
      }
    }
  }

  async checkLimitOrderStatus(order: LimitOrderState): Promise<{ filled: boolean; filledSize?: number }> {
    if (!this.isLive()) {
      return { filled: order.filled || false, filledSize: order.filled ? order.sizeUsd : 0 };
    }

    // TODO: реализовать проверку статуса через /fapi/v1/order с symbol и orderId
    // const resp = await this.callBinance('GET', '/fapi/v1/order', { symbol, orderId: ... });
    // return { filled: resp.status === 'FILLED', filledSize: ... };

    return { filled: order.filled || false, filledSize: order.filled ? order.sizeUsd : 0 };
  }

  /**
   * Упрощённый sync: получаем открытые позиции на бирже и логируем их,
   * но не берём под управление.
   */
  async syncOpenPositions(): Promise<void> {
    if (!this.isLive()) {
      console.log(
        `[BinanceExecution] Position sync skipped (mode=${config.tradeMode}, keys=${
          this.apiKey ? 'set' : 'missing'
        })`
      );
      return;
    }

    try {
      const positions = await this.callBinance('GET', '/fapi/v2/positionRisk', {});
      const nonZero = (positions as any[]).filter((p) => parseFloat(p.positionAmt) !== 0);

      if (!nonZero.length) {
        console.log('[BinanceExecution] No open futures positions detected on exchange');
        return;
      }

      console.warn('[BinanceExecution] Detected open positions on Binance (игнорируются ботом):');
      for (const p of nonZero) {
        const amt = parseFloat(p.positionAmt);
        const side = amt > 0 ? 'LONG' : 'SHORT';
        console.warn(
          `  symbol=${p.symbol}, side=${side}, positionAmt=${p.positionAmt}, entryPrice=${p.entryPrice}`
        );
      }
    } catch (error) {
      console.error('[BinanceExecution] Failed to sync open positions:', error);
    }
  }

  /**
   * Получить актуальную позицию в контрактах (лотах) для конкретного символа.
   * Возвращает { contracts: number, sizeUsd: number, entryPrice: number } или null если позиции нет.
   */
  async getPositionContracts(coin: string): Promise<{ contracts: number; sizeUsd: number; entryPrice: number } | null> {
    if (!this.isLive()) {
      return null;
    }

    try {
      const symbol = this.toSymbol(coin);
      const positions = await this.callBinance('GET', '/fapi/v2/positionRisk', { symbol });
      
      if (!Array.isArray(positions) || positions.length === 0) {
        return null;
      }

      const position = positions[0];
      const contracts = Math.abs(parseFloat(position.positionAmt));
      
      if (contracts === 0) {
        return null;
      }

      const entryPrice = parseFloat(position.entryPrice);
      const sizeUsd = contracts * entryPrice;

      if (config.logLevel === 'debug') {
        console.log(
          `[BinanceExecution] Реальная позиция ${coin}: ${contracts} contracts @ $${entryPrice.toFixed(4)} = $${sizeUsd.toFixed(2)}`
        );
      }

      return { contracts, sizeUsd, entryPrice };
    } catch (error) {
      console.error(`[BinanceExecution] Failed to get position for ${coin}:`, error);
      return null;
    }
  }
}


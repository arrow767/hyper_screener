// Типы для SDK @nktkas/hyperliquid — упрощённые, чтобы TS не ругался на импорты сабмодулей.

declare module '@nktkas/hyperliquid' {
  export class HttpTransport {
    constructor(options?: any);
  }
}

declare module '@nktkas/hyperliquid/utils' {
  export class SymbolConverter {
    static create(options: any): Promise<SymbolConverter>;
    getAssetId(coin: string): number;
    getSzDecimals(coin: string): number;
  }

  export function formatPrice(price: string, szDecimals: number, isPerp?: boolean): string;
  export function formatSize(size: string, szDecimals: number): string;
}

declare module '@nktkas/hyperliquid/api/exchange' {
  export interface OrderRequest {
    action: any;
    nonce: number;
    vaultAddress?: string;
    expiresAfter?: number;
  }

  export function order(
    options: { transport: any; wallet: { privateKey: string } },
    request: OrderRequest
  ): Promise<any>;
}



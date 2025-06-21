import axios, { AxiosInstance } from 'axios';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';

/**
 * Real World Asset Data Provider
 * Collects yield data from multiple Brazilian financial sources
 */
export class RWADataProvider {
    private logger: Logger;
    private config: Config;
    private httpClient: AxiosInstance;
    private sources: Map<string, DataSource>;
    private healthStatus: Map<string, ProviderHealth>;

    constructor(config: Config) {
        this.config = config;
        this.logger = new Logger('RWADataProvider');
        this.sources = new Map();
        this.healthStatus = new Map();
        
        this.httpClient = axios.create({
            timeout: 30000,
            headers: {
                'User-Agent': 'CambiOracle/1.0',
                'Content-Type': 'application/json'
            }
        });

        this.initializeSources();
    }

    /**
     * Initialize all data sources
     */
    private initializeSources(): void {
        // Liqi tokenized receivables
        this.sources.set('liqi', new LiqiDataSource(this.config, this.httpClient));
        
        // B3 exchange data
        this.sources.set('b3', new B3DataSource(this.config, this.httpClient));
        
        // Bank data (Itaú, Bradesco, etc.)
        this.sources.set('itau', new ItauDataSource(this.config, this.httpClient));
        this.sources.set('bradesco', new BradescoDataSource(this.config, this.httpClient));
        
        // Central Bank SELIC rate
        this.sources.set('bacen', new BacenDataSource(this.config, this.httpClient));
        
        // Custom USD receivables
        this.sources.set('usd_receivables', new USDReceivablesSource(this.config, this.httpClient));

        this.logger.info(`Initialized ${this.sources.size} data sources`);
    }

    /**
     * Start all data sources
     */
    public async start(): Promise<void> {
        this.logger.info('Starting data providers...');
        
        const startPromises = Array.from(this.sources.entries()).map(async ([name, source]) => {
            try {
                await source.start();
                this.updateHealthStatus(name, 'HEALTHY', 0, 0);
                this.logger.info(`Started data source: ${name}`);
            } catch (error) {
                this.updateHealthStatus(name, 'UNHEALTHY', 1, 0);
                this.logger.error(`Failed to start data source ${name}:`, error);
            }
        });

        await Promise.allSettled(startPromises);
        this.logger.info('Data providers startup completed');
    }

    /**
     * Stop all data sources
     */
    public async stop(): Promise<void> {
        this.logger.info('Stopping data providers...');
        
        const stopPromises = Array.from(this.sources.values()).map(source => source.stop());
        await Promise.allSettled(stopPromises);
        
        this.logger.info('Data providers stopped');
    }

    /**
     * Collect yield data for a specific asset
     */
    public async collectAssetData(assetId: string): Promise<YieldDataPoint[]> {
        const dataPoints: YieldDataPoint[] = [];
        const assetConfig = this.config.getAssetConfig(assetId);
        
        if (!assetConfig) {
            this.logger.warn(`No configuration found for asset: ${assetId}`);
            return [];
        }

        // Collect from each configured source
        for (const sourceName of assetConfig.sources) {
            const source = this.sources.get(sourceName);
            if (!source) {
                this.logger.warn(`Data source not found: ${sourceName}`);
                continue;
            }

            try {
                const startTime = Date.now();
                const data = await source.getYieldData(assetId);
                const latency = Date.now() - startTime;
                
                if (data) {
                    dataPoints.push({
                        ...data,
                        source: sourceName,
                        timestamp: Date.now()
                    });
                    
                    this.updateHealthStatus(sourceName, 'HEALTHY', 0, latency);
                }
            } catch (error) {
                this.logger.error(`Error collecting data from ${sourceName} for ${assetId}:`, error);
                this.updateHealthStatus(sourceName, 'UNHEALTHY', 1, 0);
            }
        }

        this.logger.debug(`Collected ${dataPoints.length} data points for ${assetId}`);
        return dataPoints;
    }

    /**
     * Update health status for a data source
     */
    private updateHealthStatus(
        sourceName: string,
        status: 'HEALTHY' | 'UNHEALTHY',
        errorCount: number,
        latency: number
    ): void {
        const existing = this.healthStatus.get(sourceName);
        
        this.healthStatus.set(sourceName, {
            status,
            lastUpdate: new Date().toISOString(),
            errorCount: existing ? existing.errorCount + errorCount : errorCount,
            latency
        });
    }

    /**
     * Get health status of all sources
     */
    public async getSourceHealth(): Promise<Record<string, ProviderHealth>> {
        const health: Record<string, ProviderHealth> = {};
        
        for (const [name, status] of this.healthStatus.entries()) {
            health[name] = status;
        }
        
        return health;
    }
}

/**
 * Base class for data sources
 */
abstract class DataSource {
    protected config: Config;
    protected httpClient: AxiosInstance;
    protected logger: Logger;

    constructor(config: Config, httpClient: AxiosInstance) {
        this.config = config;
        this.httpClient = httpClient;
        this.logger = new Logger(this.constructor.name);
    }

    abstract start(): Promise<void>;
    abstract stop(): Promise<void>;
    abstract getYieldData(assetId: string): Promise<YieldData | null>;
}

/**
 * Liqi tokenized receivables data source
 */
class LiqiDataSource extends DataSource {
    private apiKey: string;
    private baseUrl: string = 'https://api.liqi.com.br';

    constructor(config: Config, httpClient: AxiosInstance) {
        super(config, httpClient);
        this.apiKey = config.LIQI_API_KEY;
    }

    async start(): Promise<void> {
        // Test API connection
        await this.httpClient.get(`${this.baseUrl}/health`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
    }

    async stop(): Promise<void> {
        // No cleanup needed for HTTP source
    }

    async getYieldData(assetId: string): Promise<YieldData | null> {
        try {
            const response = await this.httpClient.get(`${this.baseUrl}/receivables/yield`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                params: { asset_type: this.mapAssetId(assetId) }
            });

            const data = response.data;
            
            return {
                yield: Math.round(data.average_yield * 100), // Convert to basis points
                confidence: this.calculateConfidence(data),
                metadata: {
                    volume: data.total_volume,
                    count: data.receivables_count,
                    averageMaturity: data.average_maturity_days
                }
            };
        } catch (error) {
            this.logger.error(`Error fetching Liqi data for ${assetId}:`, error);
            return null;
        }
    }

    private mapAssetId(assetId: string): string {
        const mapping: Record<string, string> = {
            'cmBRL': 'brl_receivables',
            'cmUSD': 'usd_receivables',
            'cmBTC': 'crypto_backed'
        };
        return mapping[assetId] || 'brl_receivables';
    }

    private calculateConfidence(data: any): number {
        // Higher volume and more receivables = higher confidence
        const volumeScore = Math.min(data.total_volume / 10000000, 1) * 40; // Max 40 points
        const countScore = Math.min(data.receivables_count / 100, 1) * 30; // Max 30 points
        const freshScore = 30; // Always fresh data from API
        
        return Math.round(volumeScore + countScore + freshScore);
    }
}

/**
 * B3 exchange data source for government bonds
 */
class B3DataSource extends DataSource {
    private apiKey: string;
    private baseUrl: string = 'https://api.b3.com.br';

    constructor(config: Config, httpClient: AxiosInstance) {
        super(config, httpClient);
        this.apiKey = config.B3_API_KEY;
    }

    async start(): Promise<void> {
        // Test connection
        await this.httpClient.get(`${this.baseUrl}/market-data/bonds`, {
            headers: { 'X-API-Key': this.apiKey }
        });
    }

    async stop(): Promise<void> {
        // No cleanup needed
    }

    async getYieldData(assetId: string): Promise<YieldData | null> {
        try {
            const bondType = this.getBondType(assetId);
            const response = await this.httpClient.get(`${this.baseUrl}/market-data/bonds/${bondType}`, {
                headers: { 'X-API-Key': this.apiKey }
            });

            const bonds = response.data.bonds;
            const avgYield = bonds.reduce((sum: number, bond: any) => sum + bond.yield, 0) / bonds.length;
            
            return {
                yield: Math.round(avgYield * 100), // Convert to basis points
                confidence: this.calculateBondConfidence(bonds),
                metadata: {
                    bondCount: bonds.length,
                    totalVolume: bonds.reduce((sum: number, bond: any) => sum + bond.volume, 0),
                    averageMaturity: bonds.reduce((sum: number, bond: any) => sum + bond.maturityDays, 0) / bonds.length
                }
            };
        } catch (error) {
            this.logger.error(`Error fetching B3 data for ${assetId}:`, error);
            return null;
        }
    }

    private getBondType(assetId: string): string {
        const mapping: Record<string, string> = {
            'cmBRL': 'LTN', // Tesouro Prefixado
            'cmUSD': 'NTN-B', // Tesouro IPCA+
            'cmBTC': 'LTN' // Default to prefixed
        };
        return mapping[assetId] || 'LTN';
    }

    private calculateBondConfidence(bonds: any[]): number {
        const volumeScore = Math.min(bonds.length / 50, 1) * 50; // Max 50 points for variety
        const liquidityScore = bonds.some(b => b.volume > 1000000) ? 30 : 20; // Liquidity bonus
        const freshScore = 20; // Market data freshness
        
        return Math.round(volumeScore + liquidityScore + freshScore);
    }
}

/**
 * Itaú bank data source
 */
class ItauDataSource extends DataSource {
    private apiKey: string;
    private baseUrl: string = 'https://api.itau.com.br';

    constructor(config: Config, httpClient: AxiosInstance) {
        super(config, httpClient);
        this.apiKey = config.ITAU_API_KEY;
    }

    async start(): Promise<void> {
        // Test connection with bank API
        await this.httpClient.get(`${this.baseUrl}/rates/current`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
    }

    async stop(): Promise<void> {
        // No cleanup needed
    }

    async getYieldData(assetId: string): Promise<YieldData | null> {
        try {
            const response = await this.httpClient.get(`${this.baseUrl}/rates/investment`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                params: { 
                    product_type: this.getProductType(assetId),
                    term: '365' // 1 year term
                }
            });

            const rate = response.data.rate;
            
            return {
                yield: Math.round(rate * 100), // Convert to basis points
                confidence: 85, // High confidence for bank data
                metadata: {
                    source: 'itau',
                    productType: this.getProductType(assetId),
                    term: 365
                }
            };
        } catch (error) {
            this.logger.error(`Error fetching Itaú data for ${assetId}:`, error);
            return null;
        }
    }

    private getProductType(assetId: string): string {
        const mapping: Record<string, string> = {
            'cmBRL': 'CDB',
            'cmUSD': 'CDB_USD',
            'cmBTC': 'PRIVATE_CREDIT'
        };
        return mapping[assetId] || 'CDB';
    }
}

/**
 * Bradesco bank data source
 */
class BradescoDataSource extends DataSource {
    private apiKey: string;
    private baseUrl: string = 'https://api.bradesco.com.br';

    constructor(config: Config, httpClient: AxiosInstance) {
        super(config, httpClient);
        this.apiKey = config.BRADESCO_API_KEY;
    }

    async start(): Promise<void> {
        await this.httpClient.get(`${this.baseUrl}/investment/rates`, {
            headers: { 'X-API-Key': this.apiKey }
        });
    }

    async stop(): Promise<void> {
        // No cleanup needed
    }

    async getYieldData(assetId: string): Promise<YieldData | null> {
        try {
            const response = await this.httpClient.get(`${this.baseUrl}/investment/rates`, {
                headers: { 'X-API-Key': this.apiKey },
                params: { asset_class: this.getAssetClass(assetId) }
            });

            const avgRate = response.data.average_rate;
            
            return {
                yield: Math.round(avgRate * 100),
                confidence: 80,
                metadata: {
                    source: 'bradesco',
                    assetClass: this.getAssetClass(assetId)
                }
            };
        } catch (error) {
            this.logger.error(`Error fetching Bradesco data for ${assetId}:`, error);
            return null;
        }
    }

    private getAssetClass(assetId: string): string {
        const mapping: Record<string, string> = {
            'cmBRL': 'FIXED_INCOME',
            'cmUSD': 'FOREX_FUND',
            'cmBTC': 'ALTERNATIVE'
        };
        return mapping[assetId] || 'FIXED_INCOME';
    }
}

/**
 * Central Bank (Bacen) data source for SELIC rate
 */
class BacenDataSource extends DataSource {
    private baseUrl: string = 'https://api.bcb.gov.br';

    async start(): Promise<void> {
        // Test connection to Central Bank API
        await this.httpClient.get(`${this.baseUrl}/dados/serie/bcdata.sgd.gov.br/ws/dados/serie/11/dados/ultimos/1?formato=json`);
    }

    async stop(): Promise<void> {
        // No cleanup needed
    }

    async getYieldData(assetId: string): Promise<YieldData | null> {
        try {
            // Get SELIC rate (series 11)
            const response = await this.httpClient.get(
                `${this.baseUrl}/dados/serie/bcdata.sgd.gov.br/ws/dados/serie/11/dados/ultimos/1?formato=json`
            );

            const selicRate = parseFloat(response.data[0].valor);
            
            // Apply multiplier based on asset
            const multiplier = this.getSelicMultiplier(assetId);
            const adjustedYield = selicRate * multiplier;
            
            return {
                yield: Math.round(adjustedYield * 100),
                confidence: 95, // Very high confidence for central bank data
                metadata: {
                    source: 'bacen',
                    baseRate: selicRate,
                    multiplier: multiplier
                }
            };
        } catch (error) {
            this.logger.error(`Error fetching Bacen data for ${assetId}:`, error);
            return null;
        }
    }

    private getSelicMultiplier(assetId: string): number {
        // Multipliers based on typical spread over SELIC
        const multipliers: Record<string, number> = {
            'cmBRL': 1.8, // Private credit typically 80% above SELIC
            'cmUSD': 1.4, // USD assets typically 40% above SELIC
            'cmBTC': 1.2  // Conservative multiplier for BTC
        };
        return multipliers[assetId] || 1.5;
    }
}

/**
 * USD receivables data source
 */
class USDReceivablesSource extends DataSource {
    private apiKey: string;
    private baseUrl: string;

    constructor(config: Config, httpClient: AxiosInstance) {
        super(config, httpClient);
        this.apiKey = config.USD_RECEIVABLES_API_KEY;
        this.baseUrl = config.USD_RECEIVABLES_BASE_URL;
    }

    async start(): Promise<void> {
        await this.httpClient.get(`${this.baseUrl}/health`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
    }

    async stop(): Promise<void> {
        // No cleanup needed
    }

    async getYieldData(assetId: string): Promise<YieldData | null> {
        if (assetId !== 'cmUSD') {
            return null; // Only handle USD receivables
        }

        try {
            const response = await this.httpClient.get(`${this.baseUrl}/receivables/usd-yields`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });

            const data = response.data;
            
            return {
                yield: Math.round(data.weighted_avg_yield * 100),
                confidence: this.calculateUSDConfidence(data),
                metadata: {
                    totalVolume: data.total_volume_usd,
                    exporterCount: data.exporter_count,
                    avgMaturity: data.avg_maturity_days,
                    hedgeRatio: data.hedge_ratio
                }
            };
        } catch (error) {
            this.logger.error(`Error fetching USD receivables data:`, error);
            return null;
        }
    }

    private calculateUSDConfidence(data: any): number {
        const volumeScore = Math.min(data.total_volume_usd / 50000000, 1) * 40; // Max 40 for $50M+
        const hedgeScore = data.hedge_ratio * 30; // Max 30 for fully hedged
        const diversityScore = Math.min(data.exporter_count / 20, 1) * 30; // Max 30 for 20+ exporters
        
        return Math.round(volumeScore + hedgeScore + diversityScore);
    }
}

// Export types
export interface YieldData {
    yield: number; // In basis points
    confidence: number; // 0-100
    metadata: Record<string, any>;
}

export interface YieldDataPoint extends YieldData {
    source: string;
    timestamp: number;
}

export interface ProviderHealth {
    status: 'HEALTHY' | 'UNHEALTHY';
    lastUpdate: string;
    errorCount: number;
    latency: number;
}
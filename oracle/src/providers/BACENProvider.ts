import axios, { AxiosInstance, AxiosError } from 'axios';
import { Logger } from '../../utils/Logger';
import { Config } from '../../config/Config';
import { 
  IDataProvider, 
  ICachedDataProvider,
  YieldData, 
  ProviderHealth, 
  RateLimitInfo,
  DataProviderConfig,
  DataProviderError,
  DataProviderErrorType
} from '../interfaces/IDataProvider';

/**
 * BACEN Data Provider for Brazilian Central Bank (Banco Central do Brasil)
 * Provides official SELIC rate, inflation data, and other monetary policy indicators
 */
export class BACENProvider implements IDataProvider, ICachedDataProvider {
  private logger: Logger;
  private config: DataProviderConfig;
  private httpClient: AxiosInstance;
  private health: ProviderHealth;
  private cache: Map<string, { data: YieldData; timestamp: number }>;
  private rateLimitInfo: RateLimitInfo;
  private statistics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalLatency: number;
    lastSuccessfulUpdate: number;
  };

  private readonly SUPPORTED_ASSETS = ['cmBRL', 'cmUSD', 'cmBTC'];
  private readonly BASE_URL = 'https://api.bcb.gov.br';
  private readonly SGS_BASE_URL = 'https://api.bcb.gov.br/dados/serie';
  
  // BACEN time series codes
  private readonly SERIES_CODES = {
    SELIC: 11, // SELIC rate
    IPCA: 433, // IPCA inflation
    CDI: 12, // CDI rate
    TJLP: 256, // Long-term interest rate
    EXCHANGE_RATE_USD: 1, // USD/BRL exchange rate
    BASE_MONEY: 1785, // Base money
    GOVERNMENT_BOND_YIELD: 226 // Government bond yield
  };

  // Asset multipliers based on typical spreads over SELIC
  private readonly SELIC_MULTIPLIERS = {
    'cmBRL': 1.8, // Private credit typically 80% above SELIC
    'cmUSD': 1.4, // USD assets typically 40% above SELIC  
    'cmBTC': 1.2 // Conservative multiplier for BTC
  };

  constructor(config: Config) {
    this.logger = new Logger('BACENProvider');
    
    this.config = {
      name: 'Brazilian Central Bank (BACEN)',
      baseUrl: this.BASE_URL,
      timeout: 15000,
      retryAttempts: 2,
      retryDelay: 1000,
      rateLimit: {
        requestsPerMinute: 120, // BACEN has generous rate limits
        requestsUsed: 0,
        resetTime: Date.now() + 60000
      },
      healthCheckInterval: 900000, // 15 minutes
      enableCaching: true,
      cacheTTL: 1800000 // 30 minutes - central bank data updates less frequently
    };

    this.httpClient = axios.create({
      timeout: this.config.timeout,
      headers: {
        'User-Agent': 'CambiOracle/1.0',
        'Accept': 'application/json'
      }
    });

    this.health = {
      status: 'UNHEALTHY',
      lastUpdate: new Date().toISOString(),
      errorCount: 0,
      successCount: 0,
      latency: 0,
      uptime: 0
    };

    this.cache = new Map();
    this.rateLimitInfo = { ...this.config.rateLimit };

    this.statistics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      lastSuccessfulUpdate: 0
    };

    this.setupHttpInterceptors();
  }

  private setupHttpInterceptors(): void {
    // Request interceptor for rate limiting
    this.httpClient.interceptors.request.use(
      (config) => {
        this.updateRateLimit();
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling and statistics
    this.httpClient.interceptors.response.use(
      (response) => {
        this.statistics.successfulRequests++;
        this.health.successCount++;
        this.health.status = 'HEALTHY';
        return response;
      },
      (error: AxiosError) => {
        this.statistics.failedRequests++;
        this.health.errorCount++;
        
        if (error.response?.status === 429) {
          this.health.status = 'DEGRADED';
        } else if (error.response?.status && error.response.status >= 500) {
          this.health.status = 'DEGRADED';
        } else {
          this.health.status = 'UNHEALTHY';
        }
        
        throw error;
      }
    );
  }

  private updateRateLimit(): void {
    const now = Date.now();
    
    if (now > this.rateLimitInfo.resetTime) {
      this.rateLimitInfo.requestsUsed = 0;
      this.rateLimitInfo.resetTime = now + 60000;
    }

    this.rateLimitInfo.requestsUsed++;

    if (this.rateLimitInfo.requestsUsed >= this.rateLimitInfo.requestsPerMinute) {
      throw new DataProviderError(
        'Rate limit exceeded for BACEN API',
        DataProviderErrorType.RATE_LIMIT_ERROR,
        this.getName(),
        true,
        { resetTime: this.rateLimitInfo.resetTime }
      );
    }
  }

  public async start(): Promise<void> {
    this.logger.info('Starting BACEN data provider...');
    
    try {
      // Test connection
      const isConnected = await this.testConnection();
      if (!isConnected) {
        throw new Error('Failed to establish connection to BACEN API');
      }

      this.health.status = 'HEALTHY';
      this.health.lastUpdate = new Date().toISOString();
      
      this.logger.info('BACEN provider started successfully');
    } catch (error) {
      this.health.status = 'UNHEALTHY';
      this.health.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start BACEN provider', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping BACEN data provider...');
    this.clearAllCache();
    this.health.status = 'UNHEALTHY';
  }

  public async getYieldData(assetId: string): Promise<YieldData | null> {
    try {
      const startTime = Date.now();
      this.statistics.totalRequests++;

      // Check cache first
      if (this.config.enableCaching && this.isCacheFresh(assetId)) {
        const cached = this.getCachedData(assetId);
        if (cached) {
          this.logger.debug(`Returning cached BACEN data for ${assetId}`);
          return cached;
        }
      }

      // Get SELIC rate and other relevant indicators
      const [selicData, cdiData, ipcaData] = await Promise.all([
        this.getTimeSeries(this.SERIES_CODES.SELIC, 1), // Last value
        this.getTimeSeries(this.SERIES_CODES.CDI, 1),
        this.getTimeSeries(this.SERIES_CODES.IPCA, 1)
      ]);

      if (!selicData || selicData.length === 0) {
        this.logger.warn('No SELIC data available from BACEN');
        return null;
      }

      const yieldData = this.validateData({
        selic: selicData[0],
        cdi: cdiData?.[0],
        ipca: ipcaData?.[0],
        assetId,
        timestamp: Date.now()
      });

      if (yieldData) {
        // Cache the result
        if (this.config.enableCaching) {
          this.setCachedData(assetId, yieldData);
        }

        // Update statistics
        const latency = Date.now() - startTime;
        this.statistics.totalLatency += latency;
        this.statistics.lastSuccessfulUpdate = Date.now();
        this.health.latency = latency;
      }

      return yieldData;

    } catch (error) {
      this.logger.error(`Failed to fetch BACEN yield data for ${assetId}`, error);
      this.handleError(error instanceof Error ? error : new Error('Unknown error'));
      return null;
    }
  }

  /**
   * Get time series data from BACEN SGS API
   */
  private async getTimeSeries(seriesCode: number, lastN: number = 1): Promise<any[]> {
    try {
      const url = `${this.SGS_BASE_URL}/${seriesCode}/dados/ultimos/${lastN}?formato=json`;
      const response = await this.httpClient.get(url);
      
      return response.data || [];
    } catch (error) {
      this.logger.error(`Failed to fetch time series ${seriesCode}`, error);
      throw error;
    }
  }

  public validateData(rawData: any): YieldData | null {
    try {
      const { selic, cdi, ipca, assetId, timestamp } = rawData;

      if (!selic || !selic.valor) {
        throw new Error('Missing SELIC rate data');
      }

      // Parse SELIC rate
      let selicRate = parseFloat(selic.valor.toString().replace(',', '.'));
      if (isNaN(selicRate)) {
        throw new Error('Invalid SELIC rate value');
      }

      // Get multiplier for the asset
      const multiplier = this.SELIC_MULTIPLIERS[assetId as keyof typeof this.SELIC_MULTIPLIERS] || 1.5;
      
      // Calculate adjusted yield based on asset type
      let adjustedYield = selicRate * multiplier;

      // Apply additional adjustments based on other indicators
      if (cdi && cdi.valor) {
        const cdiRate = parseFloat(cdi.valor.toString().replace(',', '.'));
        if (!isNaN(cdiRate)) {
          // Use CDI as a cross-reference for market rates
          const cdiSpread = Math.abs(selicRate - cdiRate);
          if (cdiSpread > 0.5) {
            // Large spread might indicate market stress
            adjustedYield *= 1.1; // Add 10% premium for risk
          }
        }
      }

      // Convert to basis points
      const yieldBasisPoints = Math.round(adjustedYield * 100);

      // Calculate confidence based on data quality and freshness
      const confidence = this.calculateBACENConfidence({
        selicDataAge: this.getDataAge(selic.data),
        cdiAvailable: !!cdi,
        ipcaAvailable: !!ipca,
        dataConsistency: this.checkDataConsistency(selic, cdi),
        isOfficialSource: true
      });

      const result: YieldData = {
        yield: yieldBasisPoints,
        confidence,
        metadata: {
          source: 'bacen',
          baseSelicRate: selicRate,
          appliedMultiplier: multiplier,
          cdiRate: cdi?.valor ? parseFloat(cdi.valor.toString().replace(',', '.')) : null,
          ipcaRate: ipca?.valor ? parseFloat(ipca.valor.toString().replace(',', '.')) : null,
          dataDate: selic.data,
          dataTimestamp: timestamp,
          seriesCode: this.SERIES_CODES.SELIC,
          assetId
        }
      };

      this.logger.debug('Validated BACEN yield data', {
        assetId,
        selicRate,
        multiplier,
        yieldBasisPoints,
        confidence
      });

      return result;

    } catch (error) {
      this.logger.error('BACEN data validation failed', error, { rawData });
      throw new DataProviderError(
        'BACEN data validation failed',
        DataProviderErrorType.DATA_VALIDATION_ERROR,
        this.getName(),
        true,
        { rawData }
      );
    }
  }

  private getDataAge(dataDate: string): number {
    try {
      // BACEN dates are typically in DD/MM/YYYY format
      const [day, month, year] = dataDate.split('/');
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      return Date.now() - date.getTime();
    } catch (error) {
      this.logger.warn('Failed to parse BACEN data date', { dataDate });
      return 0;
    }
  }

  private checkDataConsistency(selicData: any, cdiData: any): boolean {
    if (!selicData || !cdiData) return true; // Can't check without both

    try {
      const selicRate = parseFloat(selicData.valor.toString().replace(',', '.'));
      const cdiRate = parseFloat(cdiData.valor.toString().replace(',', '.'));

      // SELIC and CDI should be very close (usually within 0.25%)
      const spread = Math.abs(selicRate - cdiRate);
      return spread <= 0.25;
    } catch (error) {
      return false;
    }
  }

  private calculateBACENConfidence(params: {
    selicDataAge: number;
    cdiAvailable: boolean;
    ipcaAvailable: boolean;
    dataConsistency: boolean;
    isOfficialSource: boolean;
  }): number {
    const {
      selicDataAge,
      cdiAvailable,
      ipcaAvailable,
      dataConsistency,
      isOfficialSource
    } = params;

    let confidence = 0;

    // Official source bonus (0-30 points)
    confidence += isOfficialSource ? 30 : 0;

    // Data freshness (0-25 points)
    const ageDays = selicDataAge / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) {
      confidence += 25;
    } else if (ageDays <= 7) {
      confidence += 20;
    } else if (ageDays <= 30) {
      confidence += 15;
    } else {
      confidence += 5;
    }

    // Data availability (0-20 points)
    confidence += cdiAvailable ? 10 : 0;
    confidence += ipcaAvailable ? 10 : 0;

    // Data consistency (0-15 points)
    confidence += dataConsistency ? 15 : 5;

    // Central bank reliability (0-10 points)
    confidence += 10; // Always high for central bank

    return Math.round(Math.min(confidence, 100));
  }

  public async testConnection(): Promise<boolean> {
    try {
      // Test with a simple SELIC rate request
      const data = await this.getTimeSeries(this.SERIES_CODES.SELIC, 1);
      return data && data.length > 0;
    } catch (error) {
      this.logger.error('BACEN connection test failed', error);
      return false;
    }
  }

  public async getHealth(): Promise<ProviderHealth> {
    const uptime = this.statistics.totalRequests > 0 
      ? (this.statistics.successfulRequests / this.statistics.totalRequests) * 100 
      : 0;

    return {
      ...this.health,
      uptime,
      lastUpdate: new Date().toISOString()
    };
  }

  public isAvailable(): boolean {
    return this.health.status !== 'UNHEALTHY';
  }

  public getName(): string {
    return this.config.name;
  }

  public getSupportedAssets(): string[] {
    return [...this.SUPPORTED_ASSETS];
  }

  public getRateLimitInfo(): RateLimitInfo {
    return { ...this.rateLimitInfo };
  }

  // Cache implementation
  public getCachedData(assetId: string): YieldData | null {
    const cached = this.cache.get(assetId);
    if (cached && this.isCacheFresh(assetId)) {
      return cached.data;
    }
    return null;
  }

  public setCachedData(assetId: string, data: YieldData): void {
    this.cache.set(assetId, {
      data,
      timestamp: Date.now()
    });
  }

  public clearCache(assetId: string): void {
    this.cache.delete(assetId);
  }

  public clearAllCache(): void {
    this.cache.clear();
  }

  public isCacheFresh(assetId: string): boolean {
    const cached = this.cache.get(assetId);
    if (!cached) return false;
    
    const age = Date.now() - cached.timestamp;
    return age < this.config.cacheTTL;
  }

  public handleError(error: Error): boolean {
    if (error instanceof DataProviderError) {
      this.health.lastError = error.message;
      return error.isRecoverable;
    }

    if (error instanceof AxiosError) {
      this.health.lastError = `HTTP ${error.response?.status}: ${error.message}`;
      
      const status = error.response?.status;
      if (status === 429) {
        return true; // Rate limit, can retry later
      }
      if (status && status >= 500) {
        return true; // Server error, might be temporary
      }
      
      return true; // Most BACEN errors are recoverable
    }

    this.health.lastError = error.message;
    return true;
  }

  public updateConfig(config: Partial<DataProviderConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('BACEN configuration updated', config);
  }

  public getStatistics() {
    const avgLatency = this.statistics.totalRequests > 0 
      ? this.statistics.totalLatency / this.statistics.totalRequests 
      : 0;

    const uptimePercentage = this.statistics.totalRequests > 0
      ? (this.statistics.successfulRequests / this.statistics.totalRequests) * 100
      : 0;

    return {
      totalRequests: this.statistics.totalRequests,
      successfulRequests: this.statistics.successfulRequests,
      failedRequests: this.statistics.failedRequests,
      averageLatency: Math.round(avgLatency),
      uptimePercentage: Math.round(uptimePercentage * 100) / 100,
      lastSuccessfulUpdate: this.statistics.lastSuccessfulUpdate
    };
  }

  /**
   * Get multiple economic indicators at once
   */
  public async getEconomicIndicators(): Promise<{
    selic: number;
    cdi: number;
    ipca: number;
    exchangeRate: number;
  } | null> {
    try {
      const [selicData, cdiData, ipcaData, exchangeData] = await Promise.all([
        this.getTimeSeries(this.SERIES_CODES.SELIC, 1),
        this.getTimeSeries(this.SERIES_CODES.CDI, 1),
        this.getTimeSeries(this.SERIES_CODES.IPCA, 1),
        this.getTimeSeries(this.SERIES_CODES.EXCHANGE_RATE_USD, 1)
      ]);

      return {
        selic: selicData?.[0]?.valor ? parseFloat(selicData[0].valor.toString().replace(',', '.')) : 0,
        cdi: cdiData?.[0]?.valor ? parseFloat(cdiData[0].valor.toString().replace(',', '.')) : 0,
        ipca: ipcaData?.[0]?.valor ? parseFloat(ipcaData[0].valor.toString().replace(',', '.')) : 0,
        exchangeRate: exchangeData?.[0]?.valor ? parseFloat(exchangeData[0].valor.toString().replace(',', '.')) : 0
      };
    } catch (error) {
      this.logger.error('Failed to fetch economic indicators', error);
      return null;
    }
  }

  /**
   * Get historical SELIC rate data
   */
  public async getHistoricalSelic(days: number = 30): Promise<any[]> {
    try {
      return await this.getTimeSeries(this.SERIES_CODES.SELIC, days);
    } catch (error) {
      this.logger.error('Failed to fetch historical SELIC data', error);
      return [];
    }
  }
}

export default BACENProvider;

import axios, { AxiosInstance, AxiosError } from 'axios';
import { Logger } from '../../utils/Logger';
import { Config } from '../../config/Config';
import { 
  IDataProvider, 
  IAuthenticatedDataProvider,
  ICachedDataProvider,
  YieldData, 
  ProviderHealth, 
  RateLimitInfo,
  DataProviderConfig,
  DataProviderError,
  DataProviderErrorType
} from '../interfaces/IDataProvider';

/**
 * B3 Data Provider for Brazilian government bonds and fixed income securities
 * Connects to B3 (Brasil, Bolsa, Balcão) exchange API for official bond yields
 */
export class B3Provider implements IDataProvider, IAuthenticatedDataProvider, ICachedDataProvider {
  private logger: Logger;
  private config: DataProviderConfig;
  private httpClient: AxiosInstance;
  private health: ProviderHealth;
  private cache: Map<string, { data: YieldData; timestamp: number }>;
  private apiKey: string;
  private rateLimitInfo: RateLimitInfo;
  private statistics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalLatency: number;
    lastSuccessfulUpdate: number;
  };

  private readonly SUPPORTED_ASSETS = ['cmBRL', 'cmUSD'];
  private readonly BASE_URL = 'https://api.b3.com.br';
  private readonly MARKET_DATA_ENDPOINT = '/market-data/bonds';
  private readonly TREASURY_ENDPOINT = '/treasury-bonds';
  private readonly INDICES_ENDPOINT = '/indices';

  // Bond type mappings for different assets
  private readonly BOND_MAPPINGS = {
    'cmBRL': {
      primary: 'LTN', // Tesouro Prefixado
      secondary: ['NTN-F', 'LFT'], // Tesouro Prefixado + Selic
      description: 'Brazilian Government Fixed Income'
    },
    'cmUSD': {
      primary: 'NTN-B', // Tesouro IPCA+
      secondary: ['NTN-B Principal'], // Principal protected
      description: 'Inflation-linked Treasury Bonds'
    }
  };

  constructor(config: Config) {
    this.logger = new Logger('B3Provider');
    
    this.config = {
      name: 'B3 Brazilian Stock Exchange',
      apiKey: config.getEnvVar('B3_API_KEY'),
      baseUrl: this.BASE_URL,
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 2000,
      rateLimit: {
        requestsPerMinute: 30, // B3 has lower rate limits
        requestsUsed: 0,
        resetTime: Date.now() + 60000
      },
      healthCheckInterval: 600000, // 10 minutes
      enableCaching: true,
      cacheTTL: 900000 // 15 minutes - bond data changes less frequently
    };

    this.apiKey = this.config.apiKey || '';

    this.httpClient = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'X-API-Key': this.apiKey,
        'User-Agent': 'CambiOracle/1.0',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
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
        'Rate limit exceeded for B3 API',
        DataProviderErrorType.RATE_LIMIT_ERROR,
        this.getName(),
        true,
        { resetTime: this.rateLimitInfo.resetTime }
      );
    }
  }

  public async start(): Promise<void> {
    this.logger.info('Starting B3 data provider...');
    
    try {
      if (!this.apiKey) {
        throw new DataProviderError(
          'B3 API key not configured',
          DataProviderErrorType.CONFIGURATION_ERROR,
          this.getName(),
          false
        );
      }

      // Test connection
      const isConnected = await this.testConnection();
      if (!isConnected) {
        throw new Error('Failed to establish connection to B3 API');
      }

      this.health.status = 'HEALTHY';
      this.health.lastUpdate = new Date().toISOString();
      
      this.logger.info('B3 provider started successfully');
    } catch (error) {
      this.health.status = 'UNHEALTHY';
      this.health.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start B3 provider', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping B3 data provider...');
    this.clearAllCache();
    this.health.status = 'UNHEALTHY';
  }

  public async authenticate(): Promise<boolean> {
    // B3 API uses API key authentication, no separate auth step needed
    return this.apiKey !== '';
  }

  public isAuthenticated(): boolean {
    return this.apiKey !== '';
  }

  public async refreshAuth(): Promise<boolean> {
    // No refresh needed for API key auth
    return this.isAuthenticated();
  }

  public getAuthExpiry(): number {
    // API keys don't expire
    return Number.MAX_SAFE_INTEGER;
  }

  public async getYieldData(assetId: string): Promise<YieldData | null> {
    try {
      const startTime = Date.now();
      this.statistics.totalRequests++;

      // Check cache first
      if (this.config.enableCaching && this.isCacheFresh(assetId)) {
        const cached = this.getCachedData(assetId);
        if (cached) {
          this.logger.debug(`Returning cached B3 data for ${assetId}`);
          return cached;
        }
      }

      const bondMapping = this.BOND_MAPPINGS[assetId as keyof typeof this.BOND_MAPPINGS];
      if (!bondMapping) {
        this.logger.warn(`Unsupported asset ID for B3: ${assetId}`);
        return null;
      }

      // Fetch bond data for the asset
      const bondData = await this.fetchBondData(bondMapping);
      if (!bondData) {
        return null;
      }

      const yieldData = this.validateData(bondData);

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
      this.logger.error(`Failed to fetch B3 yield data for ${assetId}`, error);
      this.handleError(error instanceof Error ? error : new Error('Unknown error'));
      return null;
    }
  }

  private async fetchBondData(bondMapping: any): Promise<any> {
    try {
      // Fetch primary bond type data
      const primaryResponse = await this.httpClient.get(`${this.MARKET_DATA_ENDPOINT}/treasury`, {
        params: {
          bondType: bondMapping.primary,
          maturityRange: '90,365', // 3 months to 1 year
          includeSecondary: true
        }
      });

      const primaryBonds = primaryResponse.data.bonds || [];

      // Fetch secondary bond types if needed
      let secondaryBonds: any[] = [];
      if (bondMapping.secondary && bondMapping.secondary.length > 0) {
        for (const bondType of bondMapping.secondary) {
          try {
            const response = await this.httpClient.get(`${this.MARKET_DATA_ENDPOINT}/treasury`, {
              params: {
                bondType,
                maturityRange: '90,365'
              }
            });
            secondaryBonds = secondaryBonds.concat(response.data.bonds || []);
          } catch (error) {
            this.logger.warn(`Failed to fetch secondary bond data for ${bondType}`, error);
          }
        }
      }

      // Combine and process bond data
      const allBonds = [...primaryBonds, ...secondaryBonds];
      
      if (allBonds.length === 0) {
        this.logger.warn('No bond data available from B3');
        return null;
      }

      return {
        bonds: allBonds,
        primary: bondMapping.primary,
        timestamp: Date.now(),
        source: 'b3'
      };

    } catch (error) {
      this.logger.error('Failed to fetch bond data from B3', error);
      throw error;
    }
  }

  public validateData(rawData: any): YieldData | null {
    try {
      if (!rawData || !rawData.bonds || !Array.isArray(rawData.bonds)) {
        throw new Error('Invalid bond data format');
      }

      const bonds = rawData.bonds;
      
      if (bonds.length === 0) {
        throw new Error('No bond data available');
      }

      // Calculate weighted average yield based on volume
      let totalYieldWeighted = 0;
      let totalVolume = 0;
      let bondCount = 0;
      let validBonds = 0;

      for (const bond of bonds) {
        if (this.isValidBond(bond)) {
          const volume = bond.volume || 1; // Default weight if no volume
          const yield_ = this.parseYield(bond.yield || bond.rate);
          
          totalYieldWeighted += yield_ * volume;
          totalVolume += volume;
          validBonds++;
        }
        bondCount++;
      }

      if (validBonds === 0) {
        throw new Error('No valid bonds found in data');
      }

      const averageYield = totalVolume > 0 ? totalYieldWeighted / totalVolume : 0;
      const yieldBasisPoints = Math.round(averageYield * 100); // Convert to basis points

      // Calculate confidence based on data quality
      const confidence = this.calculateB3Confidence({
        validBonds,
        totalBonds: bondCount,
        totalVolume,
        primaryBondPresent: bonds.some(b => b.type === rawData.primary),
        dataFreshness: Date.now() - rawData.timestamp
      });

      const result: YieldData = {
        yield: yieldBasisPoints,
        confidence,
        metadata: {
          source: 'b3',
          bondCount: validBonds,
          totalVolume,
          primaryBondType: rawData.primary,
          averageMaturity: this.calculateAverageMaturity(bonds),
          yieldRange: this.calculateYieldRange(bonds),
          dataTimestamp: rawData.timestamp,
          rawAverageYield: averageYield
        }
      };

      this.logger.debug('Validated B3 yield data', {
        yieldBasisPoints,
        confidence,
        bondCount: validBonds,
        totalVolume
      });

      return result;

    } catch (error) {
      this.logger.error('B3 data validation failed', error, { rawData });
      throw new DataProviderError(
        'B3 data validation failed',
        DataProviderErrorType.DATA_VALIDATION_ERROR,
        this.getName(),
        true,
        { rawData }
      );
    }
  }

  private isValidBond(bond: any): boolean {
    return (
      bond &&
      typeof bond === 'object' &&
      (bond.yield !== undefined || bond.rate !== undefined) &&
      bond.yield !== null &&
      bond.rate !== null &&
      !isNaN(this.parseYield(bond.yield || bond.rate))
    );
  }

  private parseYield(yieldValue: any): number {
    if (typeof yieldValue === 'number') {
      return yieldValue;
    }
    
    if (typeof yieldValue === 'string') {
      // Remove percentage signs and convert
      const cleanValue = yieldValue.replace('%', '').replace(',', '.');
      const parsed = parseFloat(cleanValue);
      return isNaN(parsed) ? 0 : parsed;
    }
    
    return 0;
  }

  private calculateB3Confidence(params: {
    validBonds: number;
    totalBonds: number;
    totalVolume: number;
    primaryBondPresent: boolean;
    dataFreshness: number;
  }): number {
    const {
      validBonds,
      totalBonds,
      totalVolume,
      primaryBondPresent,
      dataFreshness
    } = params;

    let confidence = 0;

    // Bond count score (0-25 points)
    const countScore = Math.min((validBonds / 10), 1) * 25; // Max at 10 bonds
    
    // Data quality score (0-20 points)
    const qualityRatio = totalBonds > 0 ? validBonds / totalBonds : 0;
    const qualityScore = qualityRatio * 20;
    
    // Volume score (0-20 points)
    const volumeScore = Math.min((totalVolume / 1000000), 1) * 20; // Max at R$1M volume
    
    // Primary bond presence (0-15 points)
    const primaryScore = primaryBondPresent ? 15 : 10;
    
    // Freshness score (0-15 points)
    const ageMinutes = dataFreshness / (1000 * 60);
    const freshnessScore = Math.max(0, 15 - ageMinutes); // Decay over minutes
    
    // Official source bonus (0-5 points)
    const officialScore = 5; // B3 is official exchange

    confidence = countScore + qualityScore + volumeScore + primaryScore + freshnessScore + officialScore;

    return Math.round(Math.min(confidence, 100));
  }

  private calculateAverageMaturity(bonds: any[]): number {
    const validMaturities = bonds
      .map(bond => bond.maturityDays || bond.daysToMaturity)
      .filter(maturity => typeof maturity === 'number' && maturity > 0);

    if (validMaturities.length === 0) return 0;

    return validMaturities.reduce((sum, maturity) => sum + maturity, 0) / validMaturities.length;
  }

  private calculateYieldRange(bonds: any[]): { min: number; max: number } {
    const yields = bonds
      .map(bond => this.parseYield(bond.yield || bond.rate))
      .filter(yield_ => !isNaN(yield_) && yield_ > 0);

    if (yields.length === 0) {
      return { min: 0, max: 0 };
    }

    return {
      min: Math.min(...yields),
      max: Math.max(...yields)
    };
  }

  public async testConnection(): Promise<boolean> {
    try {
      const response = await this.httpClient.get('/health', {
        timeout: 10000
      });
      return response.status === 200;
    } catch (error) {
      // Try alternative endpoint
      try {
        const response = await this.httpClient.get(`${this.MARKET_DATA_ENDPOINT}/status`);
        return response.status === 200;
      } catch (fallbackError) {
        this.logger.error('B3 connection test failed', error);
        return false;
      }
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
    return this.health.status !== 'UNHEALTHY' && this.isAuthenticated();
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
      if (status === 403) {
        return false; // API key issue, not recoverable
      }
      
      return true; // Other errors might be recoverable
    }

    this.health.lastError = error.message;
    return true;
  }

  public updateConfig(config: Partial<DataProviderConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('B3 configuration updated', config);
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
   * Get specific bond type data
   */
  public async getBondsByType(bondType: string): Promise<any[]> {
    try {
      const response = await this.httpClient.get(`${this.MARKET_DATA_ENDPOINT}/treasury`, {
        params: {
          bondType,
          includeDetails: true
        }
      });

      return response.data.bonds || [];
    } catch (error) {
      this.logger.error(`Failed to fetch bonds for type ${bondType}`, error);
      return [];
    }
  }

  /**
   * Get market indices data
   */
  public async getMarketIndices(): Promise<any> {
    try {
      const response = await this.httpClient.get(`${this.INDICES_ENDPOINT}/treasury`);
      return response.data;
    } catch (error) {
      this.logger.error('Failed to fetch market indices', error);
      return null;
    }
  }
}

export default B3Provider;

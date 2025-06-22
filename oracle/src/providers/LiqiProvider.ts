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
 * Liqi Data Provider for Brazilian tokenized receivables
 * Connects to Liqi's API to fetch real-time yield data from tokenized assets
 */
export class LiqiProvider implements IDataProvider, IAuthenticatedDataProvider, ICachedDataProvider {
  private logger: Logger;
  private config: DataProviderConfig;
  private httpClient: AxiosInstance;
  private health: ProviderHealth;
  private cache: Map<string, { data: YieldData; timestamp: number }>;
  private authToken?: string;
  private authExpiry: number = 0;
  private rateLimitInfo: RateLimitInfo;
  private statistics: {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalLatency: number;
    lastSuccessfulUpdate: number;
  };

  private readonly SUPPORTED_ASSETS = ['cmBRL', 'cmUSD'];
  private readonly BASE_URL = 'https://api.liqi.com.br';
  private readonly AUTH_ENDPOINT = '/auth/token';
  private readonly RECEIVABLES_ENDPOINT = '/v2/receivables';
  private readonly YIELDS_ENDPOINT = '/v2/yields';

  constructor(config: Config) {
    this.logger = new Logger('LiqiProvider');
    
    this.config = {
      name: 'Liqi Tokenization Platform',
      apiKey: config.getEnvVar('LIQI_API_KEY'),
      baseUrl: this.BASE_URL,
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      rateLimit: {
        requestsPerMinute: 60,
        requestsUsed: 0,
        resetTime: Date.now() + 60000
      },
      healthCheckInterval: 300000, // 5 minutes
      enableCaching: true,
      cacheTTL: 300000 // 5 minutes
    };

    this.httpClient = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      headers: {
        'User-Agent': 'CambiOracle/1.0',
        'Content-Type': 'application/json',
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
    // Request interceptor for authentication
    this.httpClient.interceptors.request.use(
      (config) => {
        if (this.authToken) {
          config.headers.Authorization = `Bearer ${this.authToken}`;
        }
        
        // Update rate limit
        this.updateRateLimit();
        
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    this.httpClient.interceptors.response.use(
      (response) => {
        this.statistics.successfulRequests++;
        this.health.successCount++;
        this.health.status = 'HEALTHY';
        return response;
      },
      async (error: AxiosError) => {
        this.statistics.failedRequests++;
        this.health.errorCount++;

        if (error.response?.status === 401) {
          // Token expired, try to refresh
          try {
            await this.refreshAuth();
            // Retry original request
            return this.httpClient.request(error.config!);
          } catch (authError) {
            this.logger.error('Failed to refresh authentication', authError);
          }
        }

        throw error;
      }
    );
  }

  private updateRateLimit(): void {
    const now = Date.now();
    
    if (now > this.rateLimitInfo.resetTime) {
      this.rateLimitInfo.requestsUsed = 0;
      this.rateLimitInfo.resetTime = now + 60000; // Reset every minute
    }

    this.rateLimitInfo.requestsUsed++;

    if (this.rateLimitInfo.requestsUsed >= this.rateLimitInfo.requestsPerMinute) {
      throw new DataProviderError(
        'Rate limit exceeded',
        DataProviderErrorType.RATE_LIMIT_ERROR,
        this.getName(),
        true,
        { resetTime: this.rateLimitInfo.resetTime }
      );
    }
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Liqi data provider...');
    
    try {
      // Authenticate
      await this.authenticate();
      
      // Test connection
      const isConnected = await this.testConnection();
      if (!isConnected) {
        throw new Error('Failed to establish connection to Liqi API');
      }

      this.health.status = 'HEALTHY';
      this.health.lastUpdate = new Date().toISOString();
      
      this.logger.info('Liqi provider started successfully');
    } catch (error) {
      this.health.status = 'UNHEALTHY';
      this.health.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start Liqi provider', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Liqi data provider...');
    this.clearAllCache();
    this.health.status = 'UNHEALTHY';
  }

  public async authenticate(): Promise<boolean> {
    try {
      if (!this.config.apiKey) {
        throw new DataProviderError(
          'API key not configured',
          DataProviderErrorType.CONFIGURATION_ERROR,
          this.getName(),
          false
        );
      }

      const response = await axios.post(`${this.config.baseUrl}${this.AUTH_ENDPOINT}`, {
        apiKey: this.config.apiKey,
        scope: 'receivables:read yields:read'
      }, {
        timeout: this.config.timeout
      });

      this.authToken = response.data.accessToken;
      this.authExpiry = Date.now() + (response.data.expiresIn * 1000);

      this.logger.info('Successfully authenticated with Liqi API');
      return true;

    } catch (error) {
      this.logger.error('Failed to authenticate with Liqi API', error);
      throw new DataProviderError(
        'Authentication failed',
        DataProviderErrorType.AUTHENTICATION_ERROR,
        this.getName(),
        true,
        { error: error instanceof Error ? error.message : 'Unknown error' }
      );
    }
  }

  public isAuthenticated(): boolean {
    return this.authToken !== undefined && Date.now() < this.authExpiry;
  }

  public async refreshAuth(): Promise<boolean> {
    this.authToken = undefined;
    return this.authenticate();
  }

  public getAuthExpiry(): number {
    return this.authExpiry;
  }

  public async getYieldData(assetId: string): Promise<YieldData | null> {
    try {
      const startTime = Date.now();
      this.statistics.totalRequests++;

      // Check cache first
      if (this.config.enableCaching && this.isCacheFresh(assetId)) {
        const cached = this.getCachedData(assetId);
        if (cached) {
          this.logger.debug(`Returning cached data for ${assetId}`);
          return cached;
        }
      }

      // Ensure authentication
      if (!this.isAuthenticated()) {
        await this.authenticate();
      }

      const assetType = this.mapAssetIdToType(assetId);
      if (!assetType) {
        this.logger.warn(`Unsupported asset ID: ${assetId}`);
        return null;
      }

      // Fetch current yields for the asset type
      const response = await this.httpClient.get(`${this.YIELDS_ENDPOINT}/current`, {
        params: {
          assetType,
          aggregation: 'weighted_average',
          minMaturity: 30, // Minimum 30 days maturity
          includeMetadata: true
        }
      });

      const rawData = response.data;
      const yieldData = this.validateData(rawData);

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
      this.logger.error(`Failed to fetch yield data for ${assetId}`, error);
      this.handleError(error instanceof Error ? error : new Error('Unknown error'));
      return null;
    }
  }

  public validateData(rawData: any): YieldData | null {
    try {
      if (!rawData || typeof rawData !== 'object') {
        throw new Error('Invalid response format');
      }

      const {
        weightedAverageYield,
        confidence,
        totalVolume,
        receivablesCount,
        averageMaturity,
        yieldDistribution,
        riskMetrics
      } = rawData;

      if (typeof weightedAverageYield !== 'number' || weightedAverageYield < 0) {
        throw new Error('Invalid yield value');
      }

      // Convert yield to basis points if it's in decimal format
      let yieldBasisPoints = weightedAverageYield;
      if (weightedAverageYield < 1) {
        yieldBasisPoints = Math.round(weightedAverageYield * 10000);
      } else if (weightedAverageYield < 100) {
        yieldBasisPoints = Math.round(weightedAverageYield * 100);
      }

      // Calculate confidence score based on data quality
      const calculatedConfidence = this.calculateConfidence({
        totalVolume: totalVolume || 0,
        receivablesCount: receivablesCount || 0,
        averageMaturity: averageMaturity || 0,
        dataFreshness: Date.now(),
        yieldDistribution: yieldDistribution || {},
        providedConfidence: confidence
      });

      const result: YieldData = {
        yield: yieldBasisPoints,
        confidence: calculatedConfidence,
        metadata: {
          source: 'liqi',
          totalVolume,
          receivablesCount,
          averageMaturity,
          yieldDistribution,
          riskMetrics,
          dataTimestamp: Date.now(),
          rawYield: weightedAverageYield
        }
      };

      this.logger.debug('Validated Liqi yield data', {
        yieldBasisPoints,
        confidence: calculatedConfidence,
        volume: totalVolume
      });

      return result;

    } catch (error) {
      this.logger.error('Data validation failed', error, { rawData });
      throw new DataProviderError(
        'Data validation failed',
        DataProviderErrorType.DATA_VALIDATION_ERROR,
        this.getName(),
        true,
        { rawData }
      );
    }
  }

  private calculateConfidence(params: {
    totalVolume: number;
    receivablesCount: number;
    averageMaturity: number;
    dataFreshness: number;
    yieldDistribution: any;
    providedConfidence?: number;
  }): number {
    const {
      totalVolume,
      receivablesCount,
      averageMaturity,
      dataFreshness,
      providedConfidence
    } = params;

    let confidence = 0;

    // Volume score (0-30 points)
    const volumeScore = Math.min((totalVolume / 10000000), 1) * 30; // Max at R$10M
    
    // Count score (0-25 points)
    const countScore = Math.min((receivablesCount / 50), 1) * 25; // Max at 50 receivables
    
    // Maturity score (0-20 points) - prefer 3-12 month maturities
    const optimalMaturity = averageMaturity >= 90 && averageMaturity <= 365;
    const maturityScore = optimalMaturity ? 20 : Math.max(0, 20 - Math.abs(averageMaturity - 180) / 10);
    
    // Freshness score (0-15 points)
    const age = Date.now() - dataFreshness;
    const freshnessScore = Math.max(0, 15 - (age / 60000)); // Decay over minutes
    
    // Provider confidence (0-10 points)
    const providerScore = providedConfidence ? (providedConfidence / 100) * 10 : 10;

    confidence = volumeScore + countScore + maturityScore + freshnessScore + providerScore;

    return Math.round(Math.min(confidence, 100));
  }

  private mapAssetIdToType(assetId: string): string | null {
    const mapping: Record<string, string> = {
      'cmBRL': 'brl_receivables',
      'cmUSD': 'usd_receivables'
    };
    return mapping[assetId] || null;
  }

  public async testConnection(): Promise<boolean> {
    try {
      const response = await this.httpClient.get('/health', {
        timeout: 10000
      });
      return response.status === 200;
    } catch (error) {
      this.logger.error('Connection test failed', error);
      return false;
    }
  }

  public async getHealth(): Promise<ProviderHealth> {
    const uptimeStart = Date.now() - (this.statistics.totalRequests * 1000); // Rough estimate
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
    return this.health.status === 'HEALTHY' && this.isAuthenticated();
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
      
      // Determine if error is recoverable
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        return true; // Can try to re-authenticate
      }
      if (status === 429) {
        return true; // Rate limit, can retry later
      }
      if (status && status >= 500) {
        return true; // Server error, might be temporary
      }
      
      return false; // Client error, likely not recoverable
    }

    this.health.lastError = error.message;
    return true; // Assume recoverable for unknown errors
  }

  public updateConfig(config: Partial<DataProviderConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Configuration updated', config);
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
   * Get detailed receivables information for analysis
   */
  public async getReceivablesDetails(assetType: string): Promise<any> {
    try {
      const response = await this.httpClient.get(`${this.RECEIVABLES_ENDPOINT}/details`, {
        params: {
          assetType,
          includeRiskMetrics: true,
          includeHistorical: false
        }
      });

      return response.data;
    } catch (error) {
      this.logger.error('Failed to fetch receivables details', error);
      return null;
    }
  }

  /**
   * Get yield curve data for different maturities
   */
  public async getYieldCurve(assetType: string): Promise<any[]> {
    try {
      const response = await this.httpClient.get(`${this.YIELDS_ENDPOINT}/curve`, {
        params: {
          assetType,
          maturities: '30,60,90,180,365'
        }
      });

      return response.data.curve || [];
    } catch (error) {
      this.logger.error('Failed to fetch yield curve', error);
      return [];
    }
  }
}

export default LiqiProvider;

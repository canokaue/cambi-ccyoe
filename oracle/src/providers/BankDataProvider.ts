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

interface BankConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  endpoints: {
    rates: string;
    investments: string;
    cdb: string;
    privateCredit: string;
  };
  weight: number; // For weighted average calculation
  timeout: number;
}

/**
 * Bank Data Provider for aggregating yield data from major Brazilian banks
 * Connects to Itaú, Bradesco, Santander, and other institutional providers
 */
export class BankDataProvider implements IDataProvider, IAuthenticatedDataProvider, ICachedDataProvider {
  private logger: Logger;
  private config: DataProviderConfig;
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

  private bankConfigs: Map<string, BankConfig>;
  private httpClients: Map<string, AxiosInstance>;
  private authTokens: Map<string, { token: string; expiry: number }>;

  private readonly SUPPORTED_ASSETS = ['cmBRL', 'cmUSD', 'cmBTC'];

  private readonly BANKS = {
    ITAU: 'itau',
    BRADESCO: 'bradesco',
    SANTANDER: 'santander',
    BB: 'banco_do_brasil',
    NUBANK: 'nubank'
  };

  constructor(config: Config) {
    this.logger = new Logger('BankDataProvider');
    
    this.config = {
      name: 'Brazilian Banks Aggregate',
      baseUrl: '', // Not used for multi-bank provider
      timeout: 25000,
      retryAttempts: 3,
      retryDelay: 2000,
      rateLimit: {
        requestsPerMinute: 30,
        requestsUsed: 0,
        resetTime: Date.now() + 60000
      },
      healthCheckInterval: 600000, // 10 minutes
      enableCaching: true,
      cacheTTL: 1200000 // 20 minutes - bank rates change infrequently
    };

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
    this.bankConfigs = new Map();
    this.httpClients = new Map();
    this.authTokens = new Map();

    this.statistics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      lastSuccessfulUpdate: 0
    };

    this.initializeBankConfigs(config);
    this.setupHttpClients();
  }

  private initializeBankConfigs(config: Config): void {
    // Itaú Bank Configuration
    this.bankConfigs.set(this.BANKS.ITAU, {
      name: 'Itaú Unibanco',
      apiKey: config.getEnvVar('ITAU_API_KEY', ''),
      baseUrl: 'https://api.itau.com.br',
      endpoints: {
        rates: '/v1/rates/current',
        investments: '/v1/investment/rates',
        cdb: '/v1/products/cdb/rates',
        privateCredit: '/v1/private-credit/rates'
      },
      weight: 0.35, // Largest bank, highest weight
      timeout: 20000
    });

    // Bradesco Bank Configuration
    this.bankConfigs.set(this.BANKS.BRADESCO, {
      name: 'Bradesco',
      apiKey: config.getEnvVar('BRADESCO_API_KEY', ''),
      baseUrl: 'https://api.bradesco.com.br',
      endpoints: {
        rates: '/investment/rates',
        investments: '/investment/products/rates',
        cdb: '/cdb/current-rates',
        privateCredit: '/private-banking/rates'
      },
      weight: 0.30,
      timeout: 20000
    });

    // Santander Bank Configuration
    this.bankConfigs.set(this.BANKS.SANTANDER, {
      name: 'Santander Brasil',
      apiKey: config.getEnvVar('SANTANDER_API_KEY', ''),
      baseUrl: 'https://api.santander.com.br',
      endpoints: {
        rates: '/api/v1/rates',
        investments: '/api/v1/investment-rates',
        cdb: '/api/v1/cdb-rates',
        privateCredit: '/api/v1/structured-products'
      },
      weight: 0.25,
      timeout: 20000
    });

    // Banco do Brasil Configuration
    this.bankConfigs.set(this.BANKS.BB, {
      name: 'Banco do Brasil',
      apiKey: config.getEnvVar('BB_API_KEY', ''),
      baseUrl: 'https://api.bb.com.br',
      endpoints: {
        rates: '/v1/investment/rates',
        investments: '/v1/products/rates',
        cdb: '/v1/cdb/rates',
        privateCredit: '/v1/corporate/rates'
      },
      weight: 0.10,
      timeout: 20000
    });
  }

  private setupHttpClients(): void {
    for (const [bankId, bankConfig] of this.bankConfigs.entries()) {
      const client = axios.create({
        baseURL: bankConfig.baseUrl,
        timeout: bankConfig.timeout,
        headers: {
          'User-Agent': 'CambiOracle/1.0',
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      // Add request interceptor for authentication
      client.interceptors.request.use(
        (config) => {
          const authToken = this.authTokens.get(bankId);
          if (authToken && authToken.token) {
            config.headers.Authorization = `Bearer ${authToken.token}`;
          } else if (bankConfig.apiKey) {
            config.headers['X-API-Key'] = bankConfig.apiKey;
          }
          return config;
        },
        (error) => Promise.reject(error)
      );

      // Add response interceptor for error handling
      client.interceptors.response.use(
        (response) => {
          this.statistics.successfulRequests++;
          return response;
        },
        async (error: AxiosError) => {
          this.statistics.failedRequests++;
          
          // Handle 401 errors with token refresh
          if (error.response?.status === 401) {
            try {
              await this.authenticateBank(bankId);
              // Retry original request
              return client.request(error.config!);
            } catch (authError) {
              this.logger.error(`Failed to refresh auth for ${bankId}`, authError);
            }
          }
          
          throw error;
        }
      );

      this.httpClients.set(bankId, client);
    }
  }

  public async start(): Promise<void> {
    this.logger.info('Starting Bank Data Provider...');
    
    try {
      // Authenticate with all banks
      const authPromises = Array.from(this.bankConfigs.keys()).map(bankId => 
        this.authenticateBank(bankId).catch(error => {
          this.logger.warn(`Failed to authenticate with ${bankId}`, error);
          return false;
        })
      );

      const authResults = await Promise.all(authPromises);
      const successfulAuths = authResults.filter(result => result === true).length;

      if (successfulAuths === 0) {
        throw new Error('Failed to authenticate with any bank');
      }

      // Test connections
      const connectionTests = await this.testAllConnections();
      const healthyBanks = Object.values(connectionTests).filter(healthy => healthy).length;

      if (healthyBanks === 0) {
        throw new Error('No bank connections are healthy');
      }

      this.health.status = healthyBanks >= 2 ? 'HEALTHY' : 'DEGRADED';
      this.health.lastUpdate = new Date().toISOString();
      
      this.logger.info(`Bank provider started successfully. ${healthyBanks}/${this.bankConfigs.size} banks available`);
    } catch (error) {
      this.health.status = 'UNHEALTHY';
      this.health.lastError = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start Bank provider', error);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.logger.info('Stopping Bank data provider...');
    this.clearAllCache();
    this.authTokens.clear();
    this.health.status = 'UNHEALTHY';
  }

  private async authenticateBank(bankId: string): Promise<boolean> {
    const bankConfig = this.bankConfigs.get(bankId);
    if (!bankConfig || !bankConfig.apiKey) {
      this.logger.warn(`No API key configured for ${bankId}`);
      return false;
    }

    try {
      const client = this.httpClients.get(bankId);
      if (!client) {
        throw new Error(`No HTTP client for ${bankId}`);
      }

      // Different auth endpoints for different banks
      let authEndpoint = '/auth/token';
      let authPayload = { apiKey: bankConfig.apiKey };

      switch (bankId) {
        case this.BANKS.ITAU:
          authEndpoint = '/auth/oauth/token';
          authPayload = { 
            grant_type: 'client_credentials',
            client_id: bankConfig.apiKey,
            scope: 'rates:read investments:read'
          };
          break;
        case this.BANKS.BRADESCO:
          authEndpoint = '/oauth/token';
          authPayload = {
            grant_type: 'client_credentials',
            client_secret: bankConfig.apiKey
          };
          break;
        case this.BANKS.SANTANDER:
          authEndpoint = '/auth/api-key';
          authPayload = { apiKey: bankConfig.apiKey };
          break;
        default:
          // Default OAuth flow
          break;
      }

      const response = await axios.post(`${bankConfig.baseUrl}${authEndpoint}`, authPayload, {
        timeout: bankConfig.timeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const { access_token, token, expires_in, expiresIn } = response.data;
      const authToken = access_token || token;
      const expiry = Date.now() + ((expires_in || expiresIn || 3600) * 1000);

      if (authToken) {
        this.authTokens.set(bankId, { token: authToken, expiry });
        this.logger.info(`Successfully authenticated with ${bankConfig.name}`);
        return true;
      }

      this.logger.warn(`No token received from ${bankConfig.name}`);
      return false;

    } catch (error) {
      this.logger.error(`Failed to authenticate with ${bankId}`, error);
      return false;
    }
  }

  public async authenticate(): Promise<boolean> {
    const authResults = await Promise.all(
      Array.from(this.bankConfigs.keys()).map(bankId => this.authenticateBank(bankId))
    );
    return authResults.some(result => result === true);
  }

  public isAuthenticated(): boolean {
    const now = Date.now();
    return Array.from(this.authTokens.values()).some(
      auth => auth.token && auth.expiry > now
    );
  }

  public async refreshAuth(): Promise<boolean> {
    return this.authenticate();
  }

  public getAuthExpiry(): number {
    const expiries = Array.from(this.authTokens.values()).map(auth => auth.expiry);
    return expiries.length > 0 ? Math.max(...expiries) : 0;
  }

  public async getYieldData(assetId: string): Promise<YieldData | null> {
    try {
      const startTime = Date.now();
      this.statistics.totalRequests++;

      // Check cache first
      if (this.config.enableCaching && this.isCacheFresh(assetId)) {
        const cached = this.getCachedData(assetId);
        if (cached) {
          this.logger.debug(`Returning cached bank data for ${assetId}`);
          return cached;
        }
      }

      // Collect data from all available banks
      const bankDataPromises = Array.from(this.bankConfigs.keys()).map(bankId =>
        this.getBankYieldData(bankId, assetId).catch(error => {
          this.logger.warn(`Failed to get data from ${bankId}`, error);
          return null;
        })
      );

      const bankDataResults = await Promise.all(bankDataPromises);
      const validBankData = bankDataResults.filter(data => data !== null);

      if (validBankData.length === 0) {
        this.logger.warn(`No bank data available for ${assetId}`);
        return null;
      }

      const aggregatedData = this.aggregateBankData(validBankData, assetId);
      const yieldData = this.validateData(aggregatedData);

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
      this.logger.error(`Failed to fetch bank yield data for ${assetId}`, error);
      this.handleError(error instanceof Error ? error : new Error('Unknown error'));
      return null;
    }
  }

  private async getBankYieldData(bankId: string, assetId: string): Promise<any> {
    const bankConfig = this.bankConfigs.get(bankId);
    const client = this.httpClients.get(bankId);

    if (!bankConfig || !client) {
      throw new Error(`Bank ${bankId} not configured`);
    }

    // Determine which endpoint to use based on asset type
    let endpoint: string;
    let params: any = {};

    switch (assetId) {
      case 'cmBRL':
        endpoint = bankConfig.endpoints.cdb;
        params = { 
          product_type: 'CDB',
          term: '365', // 1 year term
          currency: 'BRL'
        };
        break;
      case 'cmUSD':
        endpoint = bankConfig.endpoints.investments;
        params = {
          asset_class: 'FOREX_FUND',
          currency: 'USD',
          min_investment: 10000
        };
        break;
      case 'cmBTC':
        endpoint = bankConfig.endpoints.privateCredit;
        params = {
          asset_class: 'ALTERNATIVE',
          risk_level: 'MODERATE'
        };
        break;
      default:
        throw new Error(`Unsupported asset ${assetId} for bank data`);
    }

    const response = await client.get(endpoint, { params });
    
    return {
      bankId,
      bankName: bankConfig.name,
      weight: bankConfig.weight,
      data: response.data,
      timestamp: Date.now()
    };
  }

  private aggregateBankData(bankDataList: any[], assetId: string): any {
    let totalWeightedYield = 0;
    let totalWeight = 0;
    const bankResults: any[] = [];

    for (const bankData of bankDataList) {
      try {
        const yieldValue = this.extractYieldFromBankData(bankData.data, bankData.bankId, assetId);
        if (yieldValue && yieldValue > 0) {
          totalWeightedYield += yieldValue * bankData.weight;
          totalWeight += bankData.weight;
          
          bankResults.push({
            bank: bankData.bankName,
            yield: yieldValue,
            weight: bankData.weight
          });
        }
      } catch (error) {
        this.logger.warn(`Failed to extract yield from ${bankData.bankId}`, error);
      }
    }

    const aggregatedYield = totalWeight > 0 ? totalWeightedYield / totalWeight : 0;

    return {
      assetId,
      aggregatedYield,
      bankCount: bankResults.length,
      totalWeight,
      bankResults,
      timestamp: Date.now()
    };
  }

  private extractYieldFromBankData(data: any, bankId: string, assetId: string): number {
    // Different banks have different response formats
    switch (bankId) {
      case this.BANKS.ITAU:
        return this.extractItauYield(data, assetId);
      case this.BANKS.BRADESCO:
        return this.extractBradescoYield(data, assetId);
      case this.BANKS.SANTANDER:
        return this.extractSantanderYield(data, assetId);
      case this.BANKS.BB:
        return this.extractBBYield(data, assetId);
      default:
        return this.extractGenericYield(data);
    }
  }

  private extractItauYield(data: any, assetId: string): number {
    if (data.rate) return parseFloat(data.rate);
    if (data.yield) return parseFloat(data.yield);
    if (data.average_rate) return parseFloat(data.average_rate);
    if (data.products && Array.isArray(data.products)) {
      const rates = data.products.map((p: any) => parseFloat(p.rate || p.yield || 0));
      return rates.reduce((sum: number, rate: number) => sum + rate, 0) / rates.length;
    }
    return 0;
  }

  private extractBradescoYield(data: any, assetId: string): number {
    if (data.average_rate) return parseFloat(data.average_rate);
    if (data.current_rate) return parseFloat(data.current_rate);
    if (data.rates && Array.isArray(data.rates)) {
      const rateValues = data.rates.map((r: any) => parseFloat(r.value || r.rate || 0));
      return rateValues.reduce((sum: number, rate: number) => sum + rate, 0) / rateValues.length;
    }
    return 0;
  }

  private extractSantanderYield(data: any, assetId: string): number {
    if (data.yield_rate) return parseFloat(data.yield_rate);
    if (data.annual_rate) return parseFloat(data.annual_rate);
    if (data.investment_rates && Array.isArray(data.investment_rates)) {
      const rates = data.investment_rates.map((r: any) => parseFloat(r.annual_yield || 0));
      return rates.reduce((sum: number, rate: number) => sum + rate, 0) / rates.length;
    }
    return 0;
  }

  private extractBBYield(data: any, assetId: string): number {
    if (data.taxa_anual) return parseFloat(data.taxa_anual);
    if (data.rendimento) return parseFloat(data.rendimento);
    return 0;
  }

  private extractGenericYield(data: any): number {
    // Try common field names
    const yieldFields = ['yield', 'rate', 'annual_rate', 'annual_yield', 'return_rate'];
    
    for (const field of yieldFields) {
      if (data[field] && typeof data[field] === 'number') {
        return data[field];
      }
      if (data[field] && typeof data[field] === 'string') {
        const parsed = parseFloat(data[field]);
        if (!isNaN(parsed)) return parsed;
      }
    }
    
    return 0;
  }

  public validateData(rawData: any): YieldData | null {
    try {
      if (!rawData || typeof rawData.aggregatedYield !== 'number') {
        throw new Error('Invalid aggregated bank data format');
      }

      const { aggregatedYield, bankCount, totalWeight, bankResults, assetId } = rawData;

      if (aggregatedYield <= 0) {
        throw new Error('Invalid aggregated yield value');
      }

      // Convert to basis points
      let yieldBasisPoints = aggregatedYield;
      if (aggregatedYield < 1) {
        yieldBasisPoints = Math.round(aggregatedYield * 10000);
      } else if (aggregatedYield < 100) {
        yieldBasisPoints = Math.round(aggregatedYield * 100);
      }

      // Calculate confidence based on data quality
      const confidence = this.calculateBankConfidence({
        bankCount,
        totalWeight,
        yieldConsistency: this.calculateYieldConsistency(bankResults),
        assetId
      });

      const result: YieldData = {
        yield: yieldBasisPoints,
        confidence,
        metadata: {
          source: 'banks_aggregate',
          bankCount,
          totalWeight,
          bankResults,
          aggregatedYield,
          assetId,
          dataTimestamp: Date.now()
        }
      };

      this.logger.debug('Validated bank aggregate data', {
        assetId,
        yieldBasisPoints,
        confidence,
        bankCount
      });

      return result;

    } catch (error) {
      this.logger.error('Bank data validation failed', error, { rawData });
      throw new DataProviderError(
        'Bank data validation failed',
        DataProviderErrorType.DATA_VALIDATION_ERROR,
        this.getName(),
        true,
        { rawData }
      );
    }
  }

  private calculateYieldConsistency(bankResults: any[]): number {
    if (bankResults.length < 2) return 1; // Perfect consistency with only one data point

    const yields = bankResults.map(r => r.yield);
    const mean = yields.reduce((sum, y) => sum + y, 0) / yields.length;
    const variance = yields.reduce((sum, y) => sum + Math.pow(y - mean, 2), 0) / yields.length;
    const stdDev = Math.sqrt(variance);
    
    // Lower standard deviation = higher consistency
    const coefficientOfVariation = stdDev / mean;
    return Math.max(0, 1 - coefficientOfVariation);
  }

  private calculateBankConfidence(params: {
    bankCount: number;
    totalWeight: number;
    yieldConsistency: number;
    assetId: string;
  }): number {
    const { bankCount, totalWeight, yieldConsistency, assetId } = params;

    let confidence = 0;

    // Bank diversity score (0-30 points)
    const diversityScore = Math.min((bankCount / 4), 1) * 30; // Max at 4 banks

    // Weight coverage score (0-25 points)
    const weightScore = Math.min(totalWeight, 1) * 25; // Max at 100% weight coverage

    // Yield consistency score (0-20 points)
    const consistencyScore = yieldConsistency * 20;

    // Institutional credibility (0-15 points)
    const credibilityScore = 15; // Banks are generally credible sources

    // Data freshness (0-10 points)
    const freshnessScore = 10; // Real-time bank data

    confidence = diversityScore + weightScore + consistencyScore + credibilityScore + freshnessScore;

    return Math.round(Math.min(confidence, 100));
  }

  private async testAllConnections(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [bankId, bankConfig] of this.bankConfigs.entries()) {
      try {
        const client = this.httpClients.get(bankId);
        if (!client) {
          results[bankId] = false;
          continue;
        }

        // Try to fetch rates endpoint
        await client.get(bankConfig.endpoints.rates, { timeout: 10000 });
        results[bankId] = true;
      } catch (error) {
        this.logger.debug(`Connection test failed for ${bankId}`, error);
        results[bankId] = false;
      }
    }

    return results;
  }

  public async testConnection(): Promise<boolean> {
    const results = await this.testAllConnections();
    return Object.values(results).some(healthy => healthy);
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
      return true; // Most bank API errors are recoverable
    }

    this.health.lastError = error.message;
    return true;
  }

  public updateConfig(config: Partial<DataProviderConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Bank provider configuration updated', config);
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
   * Get individual bank data for analysis
   */
  public async getIndividualBankData(assetId: string): Promise<Record<string, any>> {
    const results: Record<string, any> = {};

    for (const bankId of this.bankConfigs.keys()) {
      try {
        const data = await this.getBankYieldData(bankId, assetId);
        results[bankId] = data;
      } catch (error) {
        this.logger.warn(`Failed to get individual data from ${bankId}`, error);
        results[bankId] = { error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }

    return results;
  }
}

export default BankDataProvider;

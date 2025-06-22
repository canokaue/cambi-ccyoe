/**
 * Interface for data providers in the Cambi Oracle System
 * Defines the contract that all data sources must implement
 */

export interface YieldData {
  yield: number; // In basis points (e.g., 1400 = 14%)
  confidence: number; // 0-100 confidence score
  metadata: Record<string, any>;
}

export interface YieldDataPoint extends YieldData {
  source: string;
  timestamp: number;
  assetId: string;
}

export interface ProviderHealth {
  status: 'HEALTHY' | 'UNHEALTHY' | 'DEGRADED';
  lastUpdate: string;
  errorCount: number;
  successCount: number;
  latency: number;
  uptime: number; // Percentage uptime
  lastError?: string;
}

export interface RateLimitInfo {
  requestsPerMinute: number;
  requestsUsed: number;
  resetTime: number;
}

export interface DataProviderConfig {
  name: string;
  apiKey?: string;
  baseUrl: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  rateLimit: RateLimitInfo;
  healthCheckInterval: number;
  enableCaching: boolean;
  cacheTTL: number;
}

/**
 * Base interface that all data providers must implement
 */
export interface IDataProvider {
  /**
   * Initialize the data provider
   */
  start(): Promise<void>;

  /**
   * Shutdown the data provider
   */
  stop(): Promise<void>;

  /**
   * Get yield data for a specific asset
   * @param assetId - The asset identifier (e.g., 'cmBTC', 'cmUSD', 'cmBRL')
   * @returns Promise<YieldData | null> - Yield data or null if unavailable
   */
  getYieldData(assetId: string): Promise<YieldData | null>;

  /**
   * Get health status of the data provider
   */
  getHealth(): Promise<ProviderHealth>;

  /**
   * Check if the provider is available
   */
  isAvailable(): boolean;

  /**
   * Get the provider name
   */
  getName(): string;

  /**
   * Get supported asset IDs
   */
  getSupportedAssets(): string[];

  /**
   * Test connection to the data source
   */
  testConnection(): Promise<boolean>;

  /**
   * Get rate limit information
   */
  getRateLimitInfo(): RateLimitInfo;

  /**
   * Get historical yield data for backtesting
   * @param assetId - Asset identifier
   * @param fromTimestamp - Start timestamp
   * @param toTimestamp - End timestamp
   * @returns Historical yield data points
   */
  getHistoricalData?(
    assetId: string, 
    fromTimestamp: number, 
    toTimestamp: number
  ): Promise<YieldDataPoint[]>;

  /**
   * Validate data before returning
   * @param data - Raw data from source
   * @returns Validated and normalized data
   */
  validateData(data: any): YieldData | null;

  /**
   * Handle provider-specific errors
   * @param error - Error object
   * @returns Whether the error is recoverable
   */
  handleError(error: Error): boolean;

  /**
   * Update provider configuration
   * @param config - New configuration
   */
  updateConfig(config: Partial<DataProviderConfig>): void;

  /**
   * Get provider statistics
   */
  getStatistics(): {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageLatency: number;
    uptimePercentage: number;
    lastSuccessfulUpdate: number;
  };
}

/**
 * Interface for real-time data providers
 */
export interface IRealtimeDataProvider extends IDataProvider {
  /**
   * Subscribe to real-time yield updates
   * @param assetId - Asset to subscribe to
   * @param callback - Callback function for updates
   */
  subscribe(assetId: string, callback: (data: YieldDataPoint) => void): Promise<void>;

  /**
   * Unsubscribe from real-time updates
   * @param assetId - Asset to unsubscribe from
   */
  unsubscribe(assetId: string): Promise<void>;

  /**
   * Check if subscribed to an asset
   */
  isSubscribed(assetId: string): boolean;
}

/**
 * Interface for cached data providers
 */
export interface ICachedDataProvider extends IDataProvider {
  /**
   * Get cached data for an asset
   */
  getCachedData(assetId: string): YieldData | null;

  /**
   * Set cached data for an asset
   */
  setCachedData(assetId: string, data: YieldData): void;

  /**
   * Clear cache for an asset
   */
  clearCache(assetId: string): void;

  /**
   * Clear all cached data
   */
  clearAllCache(): void;

  /**
   * Check if data is cached and fresh
   */
  isCacheFresh(assetId: string): boolean;
}

/**
 * Interface for authenticated data providers
 */
export interface IAuthenticatedDataProvider extends IDataProvider {
  /**
   * Authenticate with the data source
   */
  authenticate(): Promise<boolean>;

  /**
   * Check if authentication is valid
   */
  isAuthenticated(): boolean;

  /**
   * Refresh authentication token
   */
  refreshAuth(): Promise<boolean>;

  /**
   * Get authentication expiry time
   */
  getAuthExpiry(): number;
}

/**
 * Error types for data providers
 */
export enum DataProviderErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  DATA_VALIDATION_ERROR = 'DATA_VALIDATION_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  API_ERROR = 'API_ERROR',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Custom error class for data provider errors
 */
export class DataProviderError extends Error {
  public readonly type: DataProviderErrorType;
  public readonly provider: string;
  public readonly isRecoverable: boolean;
  public readonly metadata?: any;

  constructor(
    message: string,
    type: DataProviderErrorType,
    provider: string,
    isRecoverable: boolean = true,
    metadata?: any
  ) {
    super(message);
    this.name = 'DataProviderError';
    this.type = type;
    this.provider = provider;
    this.isRecoverable = isRecoverable;
    this.metadata = metadata;
  }
}

/**
 * Data provider factory interface
 */
export interface IDataProviderFactory {
  /**
   * Create a data provider instance
   */
  createProvider(type: string, config: DataProviderConfig): IDataProvider;

  /**
   * Get available provider types
   */
  getAvailableTypes(): string[];

  /**
   * Register a new provider type
   */
  registerProvider(type: string, providerClass: new (config: DataProviderConfig) => IDataProvider): void;
}

export default IDataProvider;

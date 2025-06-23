import axios, { AxiosInstance } from 'axios';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';
import { LiqiProvider } from './LiqiProvider';
import { B3Provider } from './B3Provider';
import { BACENProvider } from './BACENProvider';
import { BankDataProvider } from './BankDataProvider';
import { 
  IDataProvider, 
  YieldData, 
  YieldDataPoint, 
  ProviderHealth 
} from './interfaces/IDataProvider';

/**
 * Real World Asset Data Provider
 * Orchestrates multiple Brazilian financial data sources
 */
export class RWADataProvider {
  private logger: Logger;
  private config: Config;
  private providers: Map<string, IDataProvider>;
  private healthStatus: Map<string, ProviderHealth>;

  constructor(config: Config) {
    this.config = config;
    this.logger = new Logger('RWADataProvider');
    this.providers = new Map();
    this.healthStatus = new Map();

    this.initializeProviders();
  }

  /**
   * Initialize all data providers
   */
  private initializeProviders(): void {
    try {
      // Initialize Liqi provider for tokenized receivables
      const liqiProvider = new LiqiProvider(this.config);
      this.providers.set('liqi', liqiProvider);
      
      // Initialize B3 provider for government bonds
      const b3Provider = new B3Provider(this.config);
      this.providers.set('b3', b3Provider);
      
      // Initialize BACEN provider for central bank data
      const bacenProvider = new BACENProvider(this.config);
      this.providers.set('bacen', bacenProvider);
      
      // Initialize Banks provider for institutional rates
      const banksProvider = new BankDataProvider(this.config);
      this.providers.set('banks', banksProvider);

      this.logger.info(`Initialized ${this.providers.size} data providers`);
    } catch (error) {
      this.logger.error('Failed to initialize data providers', error);
      throw error;
    }
  }

  /**
   * Start all data providers
   */
  public async start(): Promise<void> {
    this.logger.info('Starting RWA data providers...');
    
    const startPromises = Array.from(this.providers.entries()).map(async ([name, provider]) => {
      try {
        await provider.start();
        this.updateHealthStatus(name, 'HEALTHY', 0, 0);
        this.logger.info(`Started data provider: ${name}`);
      } catch (error) {
        this.updateHealthStatus(name, 'UNHEALTHY', 1, 0);
        this.logger.error(`Failed to start data provider ${name}:`, error);
      }
    });

    await Promise.allSettled(startPromises);
    this.logger.info('RWA data providers startup completed');
  }

  /**
   * Stop all data providers
   */
  public async stop(): Promise<void> {
    this.logger.info('Stopping RWA data providers...');
    
    const stopPromises = Array.from(this.providers.values()).map(provider => provider.stop());
    await Promise.allSettled(stopPromises);
    
    this.logger.info('RWA data providers stopped');
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
      const provider = this.providers.get(sourceName);
      if (!provider) {
        this.logger.warn(`Data provider not found: ${sourceName}`);
        continue;
      }

      try {
        const startTime = Date.now();
        const data = await provider.getYieldData(assetId);
        const latency = Date.now() - startTime;
        
        if (data) {
          dataPoints.push({
            ...data,
            source: sourceName,
            timestamp: Date.now(),
            assetId
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
   * Update health status for a data provider
   */
  private updateHealthStatus(
    providerName: string,
    status: 'HEALTHY' | 'UNHEALTHY' | 'DEGRADED',
    errorCount: number,
    latency: number
  ): void {
    const existing = this.healthStatus.get(providerName);
    
    this.healthStatus.set(providerName, {
      status,
      lastUpdate: new Date().toISOString(),
      errorCount: existing ? existing.errorCount + errorCount : errorCount,
      successCount: existing ? existing.successCount + (errorCount === 0 ? 1 : 0) : (errorCount === 0 ? 1 : 0),
      latency,
      uptime: 0 // Will be calculated based on success/error ratio
    });
  }

  /**
   * Get health status of all providers
   */
  public async getSourceHealth(): Promise<Record<string, ProviderHealth>> {
    const health: Record<string, ProviderHealth> = {};
    
    for (const [name, provider] of this.providers.entries()) {
      try {
        health[name] = await provider.getHealth();
      } catch (error) {
        this.logger.error(`Failed to get health for ${name}`, error);
        health[name] = {
          status: 'UNHEALTHY',
          lastUpdate: new Date().toISOString(),
          errorCount: 1,
          successCount: 0,
          latency: 0,
          uptime: 0,
          lastError: error instanceof Error ? error.message : 'Unknown error'
        };
      }
    }
    
    return health;
  }

  /**
   * Get a specific provider
   */
  public getProvider(name: string): IDataProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all provider names
   */
  public getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Test connection for all providers
   */
  public async testAllConnections(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    
    for (const [name, provider] of this.providers.entries()) {
      try {
        results[name] = await provider.testConnection();
      } catch (error) {
        this.logger.error(`Connection test failed for ${name}`, error);
        results[name] = false;
      }
    }
    
    return results;
  }

  /**
   * Get provider statistics
   */
  public getProviderStatistics(): Record<string, any> {
    const stats: Record<string, any> = {};
    
    for (const [name, provider] of this.providers.entries()) {
      try {
        stats[name] = provider.getStatistics();
      } catch (error) {
        this.logger.error(`Failed to get statistics for ${name}`, error);
        stats[name] = { error: 'Failed to get statistics' };
      }
    }
    
    return stats;
  }
}

export default RWADataProvider;

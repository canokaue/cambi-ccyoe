import * as dotenv from 'dotenv';
import Joi from 'joi';

dotenv.config();

interface AssetConfig {
  sources: string[];
  weights: number[];
  heartbeat: number;
  deviationThreshold: number;
  targetYield: number;
  minConfidence: number;
}

interface DataSourceConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  timeout: number;
  rateLimit: number;
  retryAttempts: number;
}

/**
 * Configuration management for Cambi Oracle System
 */
export class Config {
  // Blockchain Configuration
  public readonly RPC_URL: string;
  public readonly PRIVATE_KEY: string;
  public readonly CHAIN_ID: number;
  public readonly ORACLE_CONTRACT_ADDRESS: string;
  public readonly CCYOE_CORE_ADDRESS: string;

  // Oracle Configuration
  public readonly UPDATE_INTERVAL: number;
  public readonly CONFIDENCE_THRESHOLD: number;
  public readonly MAX_DEVIATION_THRESHOLD: number;
  public readonly HEARTBEAT_TIMEOUT: number;

  // Supported Assets
  public readonly SUPPORTED_ASSETS: string[];
  public readonly ASSET_CONFIGS: Record<string, AssetConfig>;

  // Data Sources
  public readonly DATA_SOURCES: Record<string, DataSourceConfig>;

  // Redis Configuration
  public readonly REDIS_URL: string;
  public readonly REDIS_TTL: number;

  // Logging
  public readonly LOG_LEVEL: string;
  public readonly LOG_FILE: string;

  // Monitoring
  public readonly DISCORD_WEBHOOK_URL?: string;
  public readonly SLACK_WEBHOOK_URL?: string;
  public readonly ALERT_EMAIL?: string;

  // Health Check
  public readonly HEALTH_CHECK_PORT: number;
  public readonly HEALTH_CHECK_INTERVAL: number;

  // Gas Configuration
  public readonly MAX_GAS_PRICE: number;
  public readonly GAS_LIMIT: number;

  // Security
  public readonly ENABLE_SIGNATURE_VERIFICATION: boolean;
  public readonly ORACLE_PRIVATE_KEY: string;

  // Environment
  public readonly NODE_ENV: string;

  constructor() {
    // Validate environment variables
    this.validateEnvironment();

    // Blockchain Configuration
    this.RPC_URL = this.getEnvVar('RPC_URL');
    this.PRIVATE_KEY = this.getEnvVar('PRIVATE_KEY');
    this.CHAIN_ID = parseInt(this.getEnvVar('CHAIN_ID', '11155111'));
    this.ORACLE_CONTRACT_ADDRESS = this.getEnvVar('ORACLE_CONTRACT_ADDRESS', '');
    this.CCYOE_CORE_ADDRESS = this.getEnvVar('CCYOE_CORE_ADDRESS', '');

    // Oracle Configuration
    this.UPDATE_INTERVAL = parseInt(this.getEnvVar('UPDATE_INTERVAL', '3600'));
    this.CONFIDENCE_THRESHOLD = parseInt(this.getEnvVar('CONFIDENCE_THRESHOLD', '80'));
    this.MAX_DEVIATION_THRESHOLD = parseFloat(this.getEnvVar('MAX_DEVIATION_THRESHOLD', '5.0'));
    this.HEARTBEAT_TIMEOUT = parseInt(this.getEnvVar('HEARTBEAT_TIMEOUT', '7200'));

    // Supported Assets
    this.SUPPORTED_ASSETS = ['cmBTC', 'cmUSD', 'cmBRL'];
    this.ASSET_CONFIGS = this.initializeAssetConfigs();

    // Data Sources
    this.DATA_SOURCES = this.initializeDataSources();

    // Redis Configuration
    this.REDIS_URL = this.getEnvVar('REDIS_URL', 'redis://localhost:6379');
    this.REDIS_TTL = parseInt(this.getEnvVar('REDIS_TTL', '1800'));

    // Logging
    this.LOG_LEVEL = this.getEnvVar('LOG_LEVEL', 'info');
    this.LOG_FILE = this.getEnvVar('LOG_FILE', 'logs/oracle.log');

    // Monitoring
    this.DISCORD_WEBHOOK_URL = this.getEnvVar('DISCORD_WEBHOOK_URL');
    this.SLACK_WEBHOOK_URL = this.getEnvVar('SLACK_WEBHOOK_URL');
    this.ALERT_EMAIL = this.getEnvVar('ALERT_EMAIL');

    // Health Check
    this.HEALTH_CHECK_PORT = parseInt(this.getEnvVar('HEALTH_CHECK_PORT', '3001'));
    this.HEALTH_CHECK_INTERVAL = parseInt(this.getEnvVar('HEALTH_CHECK_INTERVAL', '300'));

    // Gas Configuration
    this.MAX_GAS_PRICE = parseInt(this.getEnvVar('MAX_GAS_PRICE', '50'));
    this.GAS_LIMIT = parseInt(this.getEnvVar('GAS_LIMIT', '200000'));

    // Security
    this.ENABLE_SIGNATURE_VERIFICATION = this.getEnvVar('ENABLE_SIGNATURE_VERIFICATION', 'true') === 'true';
    this.ORACLE_PRIVATE_KEY = this.getEnvVar('ORACLE_PRIVATE_KEY', this.PRIVATE_KEY);

    // Environment
    this.NODE_ENV = this.getEnvVar('NODE_ENV', 'development');
  }

  private getEnvVar(key: string, defaultValue?: string): string {
    const value = process.env[key];
    if (value === undefined || value === '') {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      throw new Error(`Environment variable ${key} is required but not set`);
    }
    return value;
  }

  private validateEnvironment(): void {
    const schema = Joi.object({
      RPC_URL: Joi.string().uri().required(),
      PRIVATE_KEY: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).required(),
      CHAIN_ID: Joi.number().integer().min(1).default(11155111),
      UPDATE_INTERVAL: Joi.number().integer().min(60).default(3600),
      CONFIDENCE_THRESHOLD: Joi.number().integer().min(0).max(100).default(80),
      MAX_DEVIATION_THRESHOLD: Joi.number().min(0).default(5.0),
      HEARTBEAT_TIMEOUT: Joi.number().integer().min(60).default(7200),
      LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
      MAX_GAS_PRICE: Joi.number().integer().min(1).default(50),
      GAS_LIMIT: Joi.number().integer().min(21000).default(200000),
      NODE_ENV: Joi.string().valid('development', 'testing', 'production').default('development'),
    });

    const { error } = schema.validate(process.env, { allowUnknown: true });
    if (error) {
      throw new Error(`Environment validation failed: ${error.message}`);
    }
  }

  private initializeAssetConfigs(): Record<string, AssetConfig> {
    return {
      cmBTC: {
        sources: ['bitcoin_lending', 'institutional'],
        weights: [0.7, 0.3],
        heartbeat: 3600,
        deviationThreshold: 0.02, // 2%
        targetYield: 500, // 5% in basis points
        minConfidence: 85
      },
      cmUSD: {
        sources: ['liqi', 'brazilian_exporters'],
        weights: [0.6, 0.4],
        heartbeat: 3600,
        deviationThreshold: 0.03, // 3%
        targetYield: 1400, // 14% in basis points
        minConfidence: 80
      },
      cmBRL: {
        sources: ['liqi', 'b3', 'bacen', 'banks'],
        weights: [0.4, 0.3, 0.2, 0.1],
        heartbeat: 3600,
        deviationThreshold: 0.05, // 5%
        targetYield: 2000, // 20% in basis points
        minConfidence: 75
      }
    };
  }

  private initializeDataSources(): Record<string, DataSourceConfig> {
    return {
      liqi: {
        name: 'Liqi Tokenization Platform',
        apiKey: this.getEnvVar('LIQI_API_KEY', ''),
        baseUrl: 'https://api.liqi.com.br',
        timeout: 30000,
        rateLimit: 60, // requests per minute
        retryAttempts: 3
      },
      b3: {
        name: 'B3 Brazilian Stock Exchange',
        apiKey: this.getEnvVar('B3_API_KEY', ''),
        baseUrl: 'https://api.b3.com.br',
        timeout: 30000,
        rateLimit: 30,
        retryAttempts: 3
      },
      bacen: {
        name: 'Brazilian Central Bank',
        apiKey: this.getEnvVar('BACEN_API_KEY', ''),
        baseUrl: 'https://api.bcb.gov.br',
        timeout: 15000,
        rateLimit: 120,
        retryAttempts: 2
      },
      banks: {
        name: 'Brazilian Banks Aggregate',
        apiKey: this.getEnvVar('ITAU_API_KEY', ''),
        baseUrl: 'https://api.banks.aggregate.br',
        timeout: 20000,
        rateLimit: 30,
        retryAttempts: 3
      },
      bitcoin_lending: {
        name: 'Bitcoin Lending Platforms',
        apiKey: '',
        baseUrl: 'https://api.defi-lending.com',
        timeout: 15000,
        rateLimit: 60,
        retryAttempts: 2
      },
      institutional: {
        name: 'Institutional Bitcoin Yields',
        apiKey: '',
        baseUrl: 'https://api.institutional-yields.com',
        timeout: 20000,
        rateLimit: 30,
        retryAttempts: 2
      },
      brazilian_exporters: {
        name: 'Brazilian Exporter Receivables',
        apiKey: this.getEnvVar('LIQI_API_KEY', ''),
        baseUrl: 'https://api.exporters-receivables.br',
        timeout: 25000,
        rateLimit: 30,
        retryAttempts: 3
      }
    };
  }

  /**
   * Get configuration for a specific asset
   */
  public getAssetConfig(assetId: string): AssetConfig | undefined {
    return this.ASSET_CONFIGS[assetId];
  }

  /**
   * Get configuration for a specific data source
   */
  public getDataSourceConfig(sourceName: string): DataSourceConfig | undefined {
    return this.DATA_SOURCES[sourceName];
  }

  /**
   * Check if running in production
   */
  public isProduction(): boolean {
    return this.NODE_ENV === 'production';
  }

  /**
   * Check if running in development
   */
  public isDevelopment(): boolean {
    return this.NODE_ENV === 'development';
  }

  /**
   * Get all asset IDs
   */
  public getAllAssetIds(): string[] {
    return this.SUPPORTED_ASSETS;
  }

  /**
   * Get all data source names
   */
  public getAllDataSources(): string[] {
    return Object.keys(this.DATA_SOURCES);
  }

  /**
   * Validate that all required contracts are configured
   */
  public validateContractsConfigured(): boolean {
    return this.ORACLE_CONTRACT_ADDRESS !== '' && this.CCYOE_CORE_ADDRESS !== '';
  }
}

export default Config;

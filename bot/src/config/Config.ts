import * as dotenv from 'dotenv';
import Joi from 'joi';

dotenv.config();

export interface AssetConfig {
  targetYield: number;
  maxDeviation: number;
  minConfidence: number;
  alertThresholds: {
    yield: number;
    confidence: number;
    staleness: number;
  };
}

/**
 * Configuration management for Cambi CCYOE Bot
 */
export class Config {
  // Blockchain Configuration
  public readonly RPC_URL: string;
  public readonly PRIVATE_KEY: string;
  public readonly CHAIN_ID: number;

  // Contract Addresses
  public readonly CCYOE_CORE_ADDRESS: string;
  public readonly ORACLE_ADDRESS: string;
  public readonly VAULT_MANAGER_ADDRESS: string;

  // Monitoring Configuration
  public readonly REBALANCE_THRESHOLD: number;
  public readonly MIN_REBALANCE_INTERVAL: number;
  public readonly GAS_PRICE_THRESHOLD: number;
  public readonly DRY_RUN: boolean;

  // Alerting Configuration
  public readonly DISCORD_WEBHOOK_URL?: string;
  public readonly SLACK_WEBHOOK_URL?: string;
  public readonly ALERT_EMAIL?: string;

  // Health Check Configuration
  public readonly HEALTH_CHECK_INTERVAL: number;
  public readonly ORACLE_STALENESS_THRESHOLD: number;

  // API Configuration
  public readonly API_PORT: number;
  public readonly API_HOST: string;

  // Database Configuration
  public readonly DATABASE_URL: string;

  // Asset Configurations
  public readonly ASSET_CONFIGS: Record<string, AssetConfig>;

  // Supported Assets
  public readonly SUPPORTED_ASSETS: string[];

  constructor() {
    this.validateEnvironment();

    // Blockchain Configuration
    this.RPC_URL = this.getEnvVar('RPC_URL');
    this.PRIVATE_KEY = this.getEnvVar('PRIVATE_KEY');
    this.CHAIN_ID = parseInt(this.getEnvVar('CHAIN_ID', '1'));

    // Contract Addresses
    this.CCYOE_CORE_ADDRESS = this.getEnvVar('CCYOE_CORE_ADDRESS');
    this.ORACLE_ADDRESS = this.getEnvVar('ORACLE_ADDRESS');
    this.VAULT_MANAGER_ADDRESS = this.getEnvVar('VAULT_MANAGER_ADDRESS');

    // Monitoring Configuration
    this.REBALANCE_THRESHOLD = parseInt(this.getEnvVar('REBALANCE_THRESHOLD', '100'));
    this.MIN_REBALANCE_INTERVAL = parseInt(this.getEnvVar('MIN_REBALANCE_INTERVAL', '3600'));
    this.GAS_PRICE_THRESHOLD = parseInt(this.getEnvVar('GAS_PRICE_THRESHOLD', '50'));
    this.DRY_RUN = this.getEnvVar('DRY_RUN', 'false') === 'true';

    // Alerting Configuration
    this.DISCORD_WEBHOOK_URL = this.getEnvVar('DISCORD_WEBHOOK_URL');
    this.SLACK_WEBHOOK_URL = this.getEnvVar('SLACK_WEBHOOK_URL');
    this.ALERT_EMAIL = this.getEnvVar('ALERT_EMAIL');

    // Health Check Configuration
    this.HEALTH_CHECK_INTERVAL = parseInt(this.getEnvVar('HEALTH_CHECK_INTERVAL', '300'));
    this.ORACLE_STALENESS_THRESHOLD = parseInt(this.getEnvVar('ORACLE_STALENESS_THRESHOLD', '3600'));

    // API Configuration
    this.API_PORT = parseInt(this.getEnvVar('API_PORT', '3000'));
    this.API_HOST = this.getEnvVar('API_HOST', '0.0.0.0');

    // Database Configuration
    this.DATABASE_URL = this.getEnvVar('DATABASE_URL', 'sqlite:./data/ccyoe-bot.db');

    // Initialize asset configurations
    this.SUPPORTED_ASSETS = ['cmBTC', 'cmUSD', 'cmBRL'];
    this.ASSET_CONFIGS = this.initializeAssetConfigs();
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
      CHAIN_ID: Joi.number().integer().min(1).default(1),
      CCYOE_CORE_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
      ORACLE_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
      VAULT_MANAGER_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
      REBALANCE_THRESHOLD: Joi.number().integer().min(1).default(100),
      MIN_REBALANCE_INTERVAL: Joi.number().integer().min(60).default(3600),
      GAS_PRICE_THRESHOLD: Joi.number().integer().min(1).default(50),
      DRY_RUN: Joi.string().valid('true', 'false').default('false'),
      HEALTH_CHECK_INTERVAL: Joi.number().integer().min(60).default(300),
      ORACLE_STALENESS_THRESHOLD: Joi.number().integer().min(300).default(3600),
      API_PORT: Joi.number().integer().min(1000).max(65535).default(3000),
      API_HOST: Joi.string().default('0.0.0.0'),
    });

    const { error } = schema.validate(process.env, { allowUnknown: true });
    if (error) {
      throw new Error(`Environment validation failed: ${error.message}`);
    }
  }

  private initializeAssetConfigs(): Record<string, AssetConfig> {
    return {
      cmBTC: {
        targetYield: 500, // 5% in basis points
        maxDeviation: 200, // 2% maximum deviation
        minConfidence: 80,
        alertThresholds: {
          yield: 1000, // Alert if yield deviates by more than 10%
          confidence: 60, // Alert if confidence drops below 60%
          staleness: 7200 // Alert if data is older than 2 hours
        }
      },
      cmUSD: {
        targetYield: 1400, // 14% in basis points
        maxDeviation: 300, // 3% maximum deviation
        minConfidence: 85,
        alertThresholds: {
          yield: 2000, // Alert if yield deviates by more than 20%
          confidence: 70, // Alert if confidence drops below 70%
          staleness: 3600 // Alert if data is older than 1 hour
        }
      },
      cmBRL: {
        targetYield: 2000, // 20% in basis points
        maxDeviation: 500, // 5% maximum deviation
        minConfidence: 80,
        alertThresholds: {
          yield: 3000, // Alert if yield deviates by more than 30%
          confidence: 65, // Alert if confidence drops below 65%
          staleness: 3600 // Alert if data is older than 1 hour
        }
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
   * Check if we're running in dry-run mode
   */
  public isDryRun(): boolean {
    return this.DRY_RUN;
  }

  /**
   * Check if running in production
   */
  public isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  /**
   * Get all supported asset IDs
   */
  public getAllAssetIds(): string[] {
    return this.SUPPORTED_ASSETS;
  }

  /**
   * Validate that all contracts are configured
   */
  public validateContractsConfigured(): boolean {
    return this.CCYOE_CORE_ADDRESS !== '' && 
           this.ORACLE_ADDRESS !== '' && 
           this.VAULT_MANAGER_ADDRESS !== '';
  }

  /**
   * Get Discord webhook URL if configured
   */
  public getDiscordWebhook(): string | undefined {
    return this.DISCORD_WEBHOOK_URL;
  }

  /**
   * Get Slack webhook URL if configured
   */
  public getSlackWebhook(): string | undefined {
    return this.SLACK_WEBHOOK_URL;
  }

  /**
   * Get alert email if configured
   */
  public getAlertEmail(): string | undefined {
    return this.ALERT_EMAIL;
  }

  /**
   * Check if any alerting is configured
   */
  public hasAlertingConfigured(): boolean {
    return !!(this.DISCORD_WEBHOOK_URL || this.SLACK_WEBHOOK_URL || this.ALERT_EMAIL);
  }
}

export default Config;

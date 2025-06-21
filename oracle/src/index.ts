import { ethers } from 'ethers';
import { RWADataProvider } from './providers/RWADataProvider';
import { YieldAggregator } from './aggregator/YieldAggregator';
import { OracleService } from './services/OracleService';
import { Logger } from './utils/Logger';
import { Config } from './config/Config';
import cron from 'node-cron';

/**
 * Main Oracle System Entry Point
 * Coordinates data collection, aggregation, and on-chain submission
 */
export class CambiOracleSystem {
    private provider: ethers.Provider;
    private signer: ethers.Signer;
    private dataProvider: RWADataProvider;
    private aggregator: YieldAggregator;
    private oracleService: OracleService;
    private logger: Logger;
    private config: Config;
    private isRunning: boolean = false;

    constructor() {
        this.config = new Config();
        this.logger = new Logger('CambiOracle');
        this.initializeComponents();
    }

    private async initializeComponents(): Promise<void> {
        try {
            // Initialize blockchain connection
            this.provider = new ethers.JsonRpcProvider(this.config.RPC_URL);
            this.signer = new ethers.Wallet(this.config.PRIVATE_KEY, this.provider);

            // Initialize components
            this.dataProvider = new RWADataProvider(this.config);
            this.aggregator = new YieldAggregator(this.config);
            this.oracleService = new OracleService(this.provider, this.signer, this.config);

            this.logger.info('Oracle system components initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize components:', error);
            throw error;
        }
    }

    /**
     * Start the oracle system
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('Oracle system is already running');
            return;
        }

        this.logger.info('Starting Cambi Oracle System...');

        try {
            // Start data providers
            await this.dataProvider.start();
            
            // Schedule periodic yield updates
            this.scheduleYieldUpdates();
            
            // Start health monitoring
            this.startHealthMonitoring();

            this.isRunning = true;
            this.logger.info('Oracle system started successfully');
        } catch (error) {
            this.logger.error('Failed to start oracle system:', error);
            throw error;
        }
    }

    /**
     * Stop the oracle system
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            this.logger.warn('Oracle system is not running');
            return;
        }

        this.logger.info('Stopping Cambi Oracle System...');

        try {
            await this.dataProvider.stop();
            this.isRunning = false;
            this.logger.info('Oracle system stopped successfully');
        } catch (error) {
            this.logger.error('Error stopping oracle system:', error);
        }
    }

    /**
     * Schedule periodic yield data updates
     */
    private scheduleYieldUpdates(): void {
        // Update every hour
        cron.schedule('0 * * * *', async () => {
            if (!this.isRunning) return;
            
            try {
                await this.updateAllAssetYields();
            } catch (error) {
                this.logger.error('Scheduled yield update failed:', error);
            }
        });

        // Emergency check every 5 minutes
        cron.schedule('*/5 * * * *', async () => {
            if (!this.isRunning) return;
            
            try {
                await this.performHealthCheck();
            } catch (error) {
                this.logger.error('Health check failed:', error);
            }
        });
    }

    /**
     * Update yields for all configured assets
     */
    private async updateAllAssetYields(): Promise<void> {
        this.logger.info('Starting scheduled yield update for all assets');

        const assets = this.config.SUPPORTED_ASSETS;
        
        for (const assetId of assets) {
            try {
                await this.updateAssetYield(assetId);
            } catch (error) {
                this.logger.error(`Failed to update yield for ${assetId}:`, error);
            }
        }

        this.logger.info('Completed scheduled yield update');
    }

    /**
     * Update yield for a specific asset
     */
    private async updateAssetYield(assetId: string): Promise<void> {
        try {
            // Collect data from all sources
            const rawData = await this.dataProvider.collectAssetData(assetId);
            
            if (rawData.length === 0) {
                this.logger.warn(`No data available for asset ${assetId}`);
                return;
            }

            // Aggregate the data
            const aggregatedYield = this.aggregator.aggregateYieldData(assetId, rawData);
            
            if (!aggregatedYield) {
                this.logger.warn(`Failed to aggregate data for asset ${assetId}`);
                return;
            }

            // Submit to blockchain
            await this.oracleService.submitYieldData(
                assetId,
                aggregatedYield.yield,
                aggregatedYield.confidence
            );

            this.logger.info(`Updated yield for ${assetId}: ${aggregatedYield.yield}bp (confidence: ${aggregatedYield.confidence}%)`);
        } catch (error) {
            this.logger.error(`Error updating yield for ${assetId}:`, error);
        }
    }

    /**
     * Perform system health check
     */
    private async performHealthCheck(): Promise<void> {
        const health = await this.getSystemHealth();
        
        if (health.overallStatus === 'CRITICAL') {
            this.logger.error('CRITICAL system health detected:', health);
            // Could trigger emergency protocols here
        } else if (health.overallStatus === 'WARNING') {
            this.logger.warn('System health warning:', health);
        }
    }

    /**
     * Start health monitoring service
     */
    private startHealthMonitoring(): void {
        // Monitor data source health every minute
        cron.schedule('* * * * *', async () => {
            if (!this.isRunning) return;
            
            const sourceHealth = await this.dataProvider.getSourceHealth();
            
            for (const [source, health] of Object.entries(sourceHealth)) {
                if (health.status === 'UNHEALTHY') {
                    this.logger.warn(`Data source ${source} is unhealthy:`, health);
                }
            }
        });
    }

    /**
     * Get comprehensive system health status
     */
    public async getSystemHealth(): Promise<SystemHealth> {
        const providerHealth = await this.dataProvider.getSourceHealth();
        const oracleHealth = await this.oracleService.getHealth();
        
        const healthyProviders = Object.values(providerHealth).filter(h => h.status === 'HEALTHY').length;
        const totalProviders = Object.keys(providerHealth).length;
        
        let overallStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
        
        if (healthyProviders === 0) {
            overallStatus = 'CRITICAL';
        } else if (healthyProviders < totalProviders * 0.5) {
            overallStatus = 'WARNING';
        }
        
        return {
            overallStatus,
            dataProviders: providerHealth,
            oracle: oracleHealth,
            lastUpdate: new Date().toISOString()
        };
    }

    /**
     * Get current yield data for an asset
     */
    public async getAssetYield(assetId: string): Promise<AssetYield | null> {
        try {
            return await this.oracleService.getAssetYield(assetId);
        } catch (error) {
            this.logger.error(`Error getting yield for ${assetId}:`, error);
            return null;
        }
    }

    /**
     * Manual yield update trigger
     */
    public async forceYieldUpdate(assetId: string): Promise<void> {
        this.logger.info(`Force updating yield for ${assetId}`);
        await this.updateAssetYield(assetId);
    }
}

export interface SystemHealth {
    overallStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    dataProviders: Record<string, ProviderHealth>;
    oracle: OracleHealth;
    lastUpdate: string;
}

export interface ProviderHealth {
    status: 'HEALTHY' | 'UNHEALTHY';
    lastUpdate: string;
    errorCount: number;
    latency: number;
}

export interface OracleHealth {
    isConnected: boolean;
    lastTransaction: string;
    gasPrice: string;
    blockNumber: number;
}

export interface AssetYield {
    assetId: string;
    yield: number;
    confidence: number;
    timestamp: number;
    isValid: boolean;
}

// Export main class and types
export * from './providers/RWADataProvider';
export * from './aggregator/YieldAggregator';
export * from './services/OracleService';
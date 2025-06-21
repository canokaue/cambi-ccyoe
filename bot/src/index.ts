import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { CCYOEMonitor } from './monitors/CCYOEMonitor';
import { RebalancingEngine } from './rebalancer/RebalancingEngine';
import { AlertSystem } from './alerts/AlertSystem';
import { HealthMonitor } from './monitors/HealthMonitor';
import { APIServer } from './api/APIServer';
import { Logger } from './utils/Logger';
import { Config } from './config/Config';
import { Database } from './database/Database';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Main Cambi CCYOE Bot Class
 * Orchestrates monitoring, rebalancing, and alerting for the CCYOE system
 */
export class CambiCCYOEBot {
    private config: Config;
    private logger: Logger;
    private publicClient: any;
    private walletClient: any;
    private account: any;
    
    // Core components
    private ccyoeMonitor: CCYOEMonitor;
    private rebalancingEngine: RebalancingEngine;
    private alertSystem: AlertSystem;
    private healthMonitor: HealthMonitor;
    private apiServer: APIServer;
    private database: Database;
    
    // State
    private isRunning: boolean = false;
    private lastRebalance: number = 0;
    private currentYields: Map<string, YieldData> = new Map();
    private systemHealth: SystemHealth = { status: 'STARTING', components: {} };

    constructor() {
        this.config = new Config();
        this.logger = new Logger('CambiCCYOEBot');
        
        this.initializeBlockchainClients();
        this.initializeComponents();
    }

    /**
     * Initialize blockchain clients with Viem
     */
    private initializeBlockchainClients(): void {
        try {
            // Get chain based on config
            const chain = this.config.CHAIN_ID === 1 ? mainnet : sepolia;
            
            // Create public client for reading
            this.publicClient = createPublicClient({
                chain,
                transport: http(this.config.RPC_URL),
            });

            // Create wallet client for transactions
            this.account = privateKeyToAccount(this.config.PRIVATE_KEY as `0x${string}`);
            this.walletClient = createWalletClient({
                account: this.account,
                chain,
                transport: http(this.config.RPC_URL),
            });

            this.logger.info(`Initialized blockchain clients for chain: ${chain.name}`);
        } catch (error) {
            this.logger.error('Failed to initialize blockchain clients:', error);
            throw error;
        }
    }

    /**
     * Initialize all bot components
     */
    private initializeComponents(): void {
        try {
            // Initialize database
            this.database = new Database(this.config);
            
            // Initialize core monitoring systems
            this.ccyoeMonitor = new CCYOEMonitor(
                this.publicClient,
                this.config,
                this.logger
            );
            
            this.rebalancingEngine = new RebalancingEngine(
                this.publicClient,
                this.walletClient,
                this.account,
                this.config,
                this.logger
            );
            
            this.alertSystem = new AlertSystem(this.config, this.logger);
            
            this.healthMonitor = new HealthMonitor(
                this.publicClient,
                this.config,
                this.logger
            );
            
            // Initialize API server
            this.apiServer = new APIServer(
                this.config,
                this.logger,
                this
            );

            this.logger.info('All bot components initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize bot components:', error);
            throw error;
        }
    }

    /**
     * Start the bot and all monitoring systems
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('Bot is already running');
            return;
        }

        this.logger.info('Starting Cambi CCYOE Bot...');

        try {
            // Initialize database connection
            await this.database.connect();
            
            // Start health monitoring first
            await this.healthMonitor.start();
            
            // Start CCYOE monitoring
            await this.ccyoeMonitor.start();
            
            // Start alert system
            await this.alertSystem.start();
            
            // Schedule monitoring tasks
            this.scheduleMonitoringTasks();
            
            // Start API server
            await this.apiServer.start();
            
            this.isRunning = true;
            this.systemHealth.status = 'RUNNING';
            
            // Send startup notification
            await this.alertSystem.sendAlert({
                level: 'INFO',
                title: 'CCYOE Bot Started',
                message: `Bot started successfully at ${new Date().toISOString()}`,
                data: {
                    account: this.account.address,
                    chain: this.config.CHAIN_ID,
                    contracts: {
                        ccyoeCore: this.config.CCYOE_CORE_ADDRESS,
                        oracle: this.config.ORACLE_ADDRESS
                    }
                }
            });

            this.logger.info('Cambi CCYOE Bot started successfully');
            
        } catch (error) {
            this.logger.error('Failed to start bot:', error);
            this.systemHealth.status = 'ERROR';
            throw error;
        }
    }

    /**
     * Stop the bot gracefully
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            this.logger.warn('Bot is not running');
            return;
        }

        this.logger.info('Stopping Cambi CCYOE Bot...');

        try {
            this.isRunning = false;
            this.systemHealth.status = 'STOPPING';
            
            // Stop API server
            await this.apiServer.stop();
            
            // Stop monitoring systems
            await this.ccyoeMonitor.stop();
            await this.healthMonitor.stop();
            await this.alertSystem.stop();
            
            // Close database connection
            await this.database.disconnect();
            
            this.systemHealth.status = 'STOPPED';
            this.logger.info('Bot stopped successfully');
            
        } catch (error) {
            this.logger.error('Error stopping bot:', error);
            this.systemHealth.status = 'ERROR';
        }
    }

    /**
     * Schedule all monitoring and maintenance tasks
     */
    private scheduleMonitoringTasks(): void {
        // Main monitoring loop - every 30 seconds
        cron.schedule('*/30 * * * * *', async () => {
            if (!this.isRunning) return;
            
            try {
                await this.runMonitoringCycle();
            } catch (error) {
                this.logger.error('Monitoring cycle failed:', error);
            }
        });

        // Rebalancing check - every 5 minutes
        cron.schedule('*/5 * * * *', async () => {
            if (!this.isRunning) return;
            
            try {
                await this.checkRebalancingConditions();
            } catch (error) {
                this.logger.error('Rebalancing check failed:', error);
            }
        });

        // Health check - every minute
        cron.schedule('* * * * *', async () => {
            if (!this.isRunning) return;
            
            try {
                await this.performHealthCheck();
            } catch (error) {
                this.logger.error('Health check failed:', error);
            }
        });

        // Daily maintenance - at 2 AM
        cron.schedule('0 2 * * *', async () => {
            if (!this.isRunning) return;
            
            try {
                await this.performDailyMaintenance();
            } catch (error) {
                this.logger.error('Daily maintenance failed:', error);
            }
        });

        this.logger.info('Scheduled monitoring tasks configured');
    }

    /**
     * Main monitoring cycle - check yields and system state
     */
    private async runMonitoringCycle(): Promise<void> {
        try {
            // Get current yield data from oracle
            const yieldData = await this.ccyoeMonitor.getAllAssetYields();
            
            // Update internal state
            for (const [assetId, data] of Object.entries(yieldData)) {
                this.currentYields.set(assetId, data);
            }
            
            // Check for anomalies and alert conditions
            await this.checkAlertConditions(yieldData);
            
            // Store data in database
            await this.database.storeYieldData(yieldData);
            
            this.logger.debug('Monitoring cycle completed', { 
                assets: Object.keys(yieldData).length,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            this.logger.error('Monitoring cycle error:', error);
            await this.alertSystem.sendAlert({
                level: 'ERROR',
                title: 'Monitoring Cycle Failed',
                message: `Failed to complete monitoring cycle: ${error.message}`,
                data: { error: error.toString() }
            });
        }
    }

    /**
     * Check if rebalancing conditions are met
     */
    private async checkRebalancingConditions(): Promise<void> {
        try {
            const rebalanceNeeded = await this.rebalancingEngine.shouldRebalance(this.currentYields);
            
            if (rebalanceNeeded.required) {
                this.logger.info('Rebalancing conditions met:', rebalanceNeeded.reason);
                
                // Check minimum time interval
                const timeSinceLastRebalance = Date.now() - this.lastRebalance;
                if (timeSinceLastRebalance < this.config.MIN_REBALANCE_INTERVAL * 1000) {
                    this.logger.warn('Rebalancing skipped - too frequent', {
                        timeSince: timeSinceLastRebalance,
                        minInterval: this.config.MIN_REBALANCE_INTERVAL
                    });
                    return;
                }
                
                // Execute rebalancing if not in dry-run mode
                if (!this.config.DRY_RUN) {
                    await this.executeRebalancing(rebalanceNeeded);
                } else {
                    this.logger.info('DRY RUN: Would execute rebalancing', rebalanceNeeded);
                }
            }
            
        } catch (error) {
            this.logger.error('Rebalancing check error:', error);
            await this.alertSystem.sendAlert({
                level: 'ERROR',
                title: 'Rebalancing Check Failed',
                message: `Error checking rebalancing conditions: ${error.message}`,
                data: { error: error.toString() }
            });
        }
    }

    /**
     * Execute rebalancing operation
     */
    private async executeRebalancing(rebalanceData: RebalanceRequired): Promise<void> {
        try {
            this.logger.info('Executing rebalancing operation...', rebalanceData);
            
            // Send pre-rebalance alert
            await this.alertSystem.sendAlert({
                level: 'INFO',
                title: 'Rebalancing Started',
                message: `Starting rebalancing operation: ${rebalanceData.reason}`,
                data: rebalanceData
            });
            
            // Execute the rebalancing
            const result = await this.rebalancingEngine.executeRebalancing(rebalanceData);
            
            if (result.success) {
                this.lastRebalance = Date.now();
                
                // Store successful rebalance in database
                await this.database.storeRebalanceEvent({
                    timestamp: new Date(),
                    reason: rebalanceData.reason,
                    txHash: result.txHash,
                    gasUsed: result.gasUsed,
                    yields: Array.from(this.currentYields.entries())
                });
                
                // Send success alert
                await this.alertSystem.sendAlert({
                    level: 'INFO',
                    title: 'Rebalancing Completed',
                    message: `Rebalancing completed successfully`,
                    data: {
                        txHash: result.txHash,
                        gasUsed: result.gasUsed,
                        reason: rebalanceData.reason
                    }
                });
                
                this.logger.info('Rebalancing completed successfully', result);
                
            } else {
                throw new Error(`Rebalancing failed: ${result.error}`);
            }
            
        } catch (error) {
            this.logger.error('Rebalancing execution failed:', error);
            await this.alertSystem.sendAlert({
                level: 'CRITICAL',
                title: 'Rebalancing Failed',
                message: `Critical error during rebalancing: ${error.message}`,
                data: { 
                    error: error.toString(),
                    rebalanceData 
                }
            });
        }
    }

    /**
     * Check for alert conditions based on yield data
     */
    private async checkAlertConditions(yieldData: Record<string, YieldData>): Promise<void> {
        for (const [assetId, data] of Object.entries(yieldData)) {
            const assetConfig = this.config.getAssetConfig(assetId);
            if (!assetConfig) continue;
            
            // Check yield deviation
            const deviation = Math.abs(data.yield - assetConfig.targetYield);
            if (deviation > assetConfig.alertThresholds.yield) {
                await this.alertSystem.sendAlert({
                    level: 'WARNING',
                    title: `High Yield Deviation - ${assetId}`,
                    message: `${assetId} yield (${data.yield}bp) deviates from target (${assetConfig.targetYield}bp) by ${deviation}bp`,
                    data: { assetId, currentYield: data.yield, targetYield: assetConfig.targetYield, deviation }
                });
            }
            
            // Check confidence score
            if (data.confidence < assetConfig.alertThresholds.confidence) {
                await this.alertSystem.sendAlert({
                    level: 'WARNING',
                    title: `Low Confidence Score - ${assetId}`,
                    message: `${assetId} confidence score (${data.confidence}%) below threshold (${assetConfig.alertThresholds.confidence}%)`,
                    data: { assetId, confidence: data.confidence, threshold: assetConfig.alertThresholds.confidence }
                });
            }
            
            // Check data staleness
            const dataAge = Date.now() - data.timestamp;
            if (dataAge > assetConfig.alertThresholds.staleness * 1000) {
                await this.alertSystem.sendAlert({
                    level: 'CRITICAL',
                    title: `Stale Data - ${assetId}`,
                    message: `${assetId} data is ${Math.round(dataAge / 1000)} seconds old (threshold: ${assetConfig.alertThresholds.staleness}s)`,
                    data: { assetId, dataAge: dataAge / 1000, threshold: assetConfig.alertThresholds.staleness }
                });
            }
        }
    }

    /**
     * Perform comprehensive health check
     */
    private async performHealthCheck(): Promise<void> {
        try {
            const health = await this.healthMonitor.getFullHealthStatus();
            this.systemHealth = health;
            
            // Alert on critical health issues
            if (health.status === 'CRITICAL') {
                await this.alertSystem.sendAlert({
                    level: 'CRITICAL',
                    title: 'System Health Critical',
                    message: 'System health check detected critical issues',
                    data: health
                });
            } else if (health.status === 'WARNING') {
                await this.alertSystem.sendAlert({
                    level: 'WARNING',
                    title: 'System Health Warning',
                    message: 'System health check detected warnings',
                    data: health
                });
            }
            
        } catch (error) {
            this.logger.error('Health check failed:', error);
            this.systemHealth.status = 'ERROR';
        }
    }

    /**
     * Daily maintenance tasks
     */
    private async performDailyMaintenance(): Promise<void> {
        try {
            this.logger.info('Starting daily maintenance...');
            
            // Clean up old database records
            await this.database.cleanupOldRecords();
            
            // Generate daily report
            const report = await this.generateDailyReport();
            
            // Send daily summary
            await this.alertSystem.sendAlert({
                level: 'INFO',
                title: 'Daily Report',
                message: 'Daily maintenance completed',
                data: report
            });
            
            this.logger.info('Daily maintenance completed');
            
        } catch (error) {
            this.logger.error('Daily maintenance failed:', error);
        }
    }

    /**
     * Generate daily performance report
     */
    private async generateDailyReport(): Promise<DailyReport> {
        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
        
        return {
            period: { start: startTime.toISOString(), end: endTime.toISOString() },
            rebalances: await this.database.getRebalanceCount(startTime, endTime),
            alerts: await this.database.getAlertCount(startTime, endTime),
            avgYields: await this.database.getAverageYields(startTime, endTime),
            systemUptime: this.calculateUptime(),
            gasUsed: await this.database.getTotalGasUsed(startTime, endTime)
        };
    }

    /**
     * Calculate system uptime percentage
     */
    private calculateUptime(): number {
        // Simple uptime calculation - in production would track actual downtime
        return this.isRunning ? 99.9 : 0;
    }

    // Public methods for API and manual operations

    /**
     * Get current system status
     */
    public getSystemStatus(): SystemStatus {
        return {
            isRunning: this.isRunning,
            health: this.systemHealth,
            lastRebalance: this.lastRebalance,
            currentYields: Object.fromEntries(this.currentYields),
            uptime: Date.now() - (this.lastRebalance || Date.now())
        };
    }

    /**
     * Force rebalancing check (manual trigger)
     */
    public async forceRebalanceCheck(): Promise<{ executed: boolean; reason?: string; txHash?: string }> {
        try {
            const rebalanceNeeded = await this.rebalancingEngine.shouldRebalance(this.currentYields);
            
            if (rebalanceNeeded.required) {
                if (!this.config.DRY_RUN) {
                    await this.executeRebalancing(rebalanceNeeded);
                    return { executed: true, reason: rebalanceNeeded.reason };
                } else {
                    return { executed: false, reason: 'DRY_RUN mode - would execute rebalancing' };
                }
            } else {
                return { executed: false, reason: 'No rebalancing needed' };
            }
        } catch (error) {
            this.logger.error('Force rebalance failed:', error);
            throw error;
        }
    }

    /**
     * Emergency pause (manual trigger)
     */
    public async emergencyPause(reason: string): Promise<{ success: boolean; txHash?: string }> {
        try {
            this.logger.warn(`Emergency pause triggered: ${reason}`);
            
            const result = await this.rebalancingEngine.emergencyPause(reason);
            
            await this.alertSystem.sendAlert({
                level: 'CRITICAL',
                title: 'Emergency Pause Executed',
                message: `System paused: ${reason}`,
                data: { reason, txHash: result.txHash }
            });
            
            return result;
        } catch (error) {
            this.logger.error('Emergency pause failed:', error);
            throw error;
        }
    }
}

// Type definitions
export interface YieldData {
    yield: number;
    confidence: number;
    timestamp: number;
    isValid: boolean;
}

export interface SystemHealth {
    status: 'STARTING' | 'RUNNING' | 'WARNING' | 'CRITICAL' | 'ERROR' | 'STOPPING' | 'STOPPED';
    components: Record<string, ComponentHealth>;
}

export interface ComponentHealth {
    status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    lastCheck: number;
    details?: any;
}

export interface RebalanceRequired {
    required: boolean;
    reason: string;
    urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    assets: string[];
    data?: any;
}

export interface SystemStatus {
    isRunning: boolean;
    health: SystemHealth;
    lastRebalance: number;
    currentYields: Record<string, YieldData>;
    uptime: number;
}

export interface DailyReport {
    period: { start: string; end: string };
    rebalances: number;
    alerts: number;
    avgYields: Record<string, number>;
    systemUptime: number;
    gasUsed: string;
}

// Start the bot if this file is run directly
if (require.main === module) {
    const bot = new CambiCCYOEBot();
    
    // Graceful shutdown handling
    process.on('SIGINT', async () => {
        console.log('Received SIGINT, shutting down gracefully...');
        await bot.stop();
        process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
        console.log('Received SIGTERM, shutting down gracefully...');
        await bot.stop();
        process.exit(0);
    });
    
    // Start the bot
    bot.start().catch(error => {
        console.error('Failed to start bot:', error);
        process.exit(1);
    });
}
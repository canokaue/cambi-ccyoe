import { PublicClient } from 'viem';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';
import { YieldData } from '../index';

/**
 * CCYOE Monitor - Monitors yield data and CCYOE protocol state
 */
export class CCYOEMonitor {
    private publicClient: PublicClient;
    private config: Config;
    private logger: Logger;
    private isRunning: boolean = false;
    
    // Contract ABIs (simplified for example)
    private ccyoeAbi = [
        {
            name: 'getAllAssetYields',
            type: 'function',
            stateMutability: 'view',
            inputs: [],
            outputs: [
                { name: 'yields', type: 'uint256[]' },
                { name: 'vaults', type: 'address[]' }
            ]
        },
        {
            name: 'getAssetConfig',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'assetId', type: 'bytes32' }],
            outputs: [
                { name: 'vaultAddress', type: 'address' },
                { name: 'targetYield', type: 'uint256' },
                { name: 'supplyCap', type: 'uint256' },
                { name: 'currentSupply', type: 'uint256' },
                { name: 'isActive', type: 'bool' },
                { name: 'lastRebalance', type: 'uint256' }
            ]
        }
    ] as const;

    private oracleAbi = [
        {
            name: 'getAssetYieldData',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'assetId', type: 'bytes32' }],
            outputs: [
                { name: 'yield', type: 'uint256' },
                { name: 'timestamp', type: 'uint256' },
                { name: 'confidence', type: 'uint256' },
                { name: 'isValid', type: 'bool' }
            ]
        },
        {
            name: 'isYieldDataValid',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'assetId', type: 'bytes32' }],
            outputs: [{ name: '', type: 'bool' }]
        }
    ] as const;

    constructor(publicClient: PublicClient, config: Config, logger: Logger) {
        this.publicClient = publicClient;
        this.config = config;
        this.logger = logger.child({ component: 'CCYOEMonitor' });
    }

    /**
     * Start monitoring
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('Monitor is already running');
            return;
        }

        this.logger.info('Starting CCYOE monitor...');
        
        try {
            // Test contract connections
            await this.testContractConnections();
            
            this.isRunning = true;
            this.logger.info('CCYOE monitor started successfully');
            
        } catch (error) {
            this.logger.error('Failed to start CCYOE monitor:', error);
            throw error;
        }
    }

    /**
     * Stop monitoring
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            this.logger.warn('Monitor is not running');
            return;
        }

        this.isRunning = false;
        this.logger.info('CCYOE monitor stopped');
    }

    /**
     * Test contract connections
     */
    private async testContractConnections(): Promise<void> {
        try {
            // Test CCYOE Core contract
            const ccyoeResult = await this.publicClient.readContract({
                address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
                abi: this.ccyoeAbi,
                functionName: 'getAllAssetYields'
            });
            
            this.logger.debug('CCYOE Core contract test successful', { 
                yieldsCount: ccyoeResult[0].length 
            });

            // Test Oracle contract
            const cmBTCBytes32 = this.stringToBytes32('cmBTC');
            const oracleResult = await this.publicClient.readContract({
                address: this.config.ORACLE_ADDRESS as `0x${string}`,
                abi: this.oracleAbi,
                functionName: 'isYieldDataValid',
                args: [cmBTCBytes32]
            });
            
            this.logger.debug('Oracle contract test successful', { 
                cmBTCValid: oracleResult 
            });
            
        } catch (error) {
            this.logger.error('Contract connection test failed:', error);
            throw new Error(`Contract test failed: ${error.message}`);
        }
    }

    /**
     * Get all asset yields from the protocol
     */
    public async getAllAssetYields(): Promise<Record<string, YieldData>> {
        if (!this.isRunning) {
            throw new Error('Monitor not running');
        }

        try {
            const assets = ['cmBTC', 'cmUSD', 'cmBRL'];
            const yieldData: Record<string, YieldData> = {};

            // Get yield data for each asset from oracle
            for (const assetId of assets) {
                try {
                    const data = await this.getAssetYieldData(assetId);
                    if (data) {
                        yieldData[assetId] = data;
                    }
                } catch (error) {
                    this.logger.error(`Failed to get yield data for ${assetId}:`, error);
                }
            }

            return yieldData;
            
        } catch (error) {
            this.logger.error('Failed to get all asset yields:', error);
            throw error;
        }
    }

    /**
     * Get yield data for a specific asset
     */
    public async getAssetYieldData(assetId: string): Promise<YieldData | null> {
        try {
            const assetBytes32 = this.stringToBytes32(assetId);
            
            // Get yield data from oracle
            const oracleData = await this.publicClient.readContract({
                address: this.config.ORACLE_ADDRESS as `0x${string}`,
                abi: this.oracleAbi,
                functionName: 'getAssetYieldData',
                args: [assetBytes32]
            });

            // Check if data is valid
            const isValid = await this.publicClient.readContract({
                address: this.config.ORACLE_ADDRESS as `0x${string}`,
                abi: this.oracleAbi,
                functionName: 'isYieldDataValid',
                args: [assetBytes32]
            });

            return {
                yield: Number(oracleData[0]), // Convert from BigInt
                confidence: Number(oracleData[2]),
                timestamp: Number(oracleData[1]) * 1000, // Convert to milliseconds
                isValid: Boolean(isValid)
            };
            
        } catch (error) {
            this.logger.error(`Failed to get yield data for ${assetId}:`, error);
            return null;
        }
    }

    /**
     * Get asset configuration from CCYOE Core
     */
    public async getAssetConfig(assetId: string): Promise<AssetConfig | null> {
        try {
            const assetBytes32 = this.stringToBytes32(assetId);
            
            const config = await this.publicClient.readContract({
                address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
                abi: this.ccyoeAbi,
                functionName: 'getAssetConfig',
                args: [assetBytes32]
            });

            return {
                vaultAddress: config[0],
                targetYield: Number(config[1]),
                supplyCap: config[2].toString(),
                currentSupply: config[3].toString(),
                isActive: config[4],
                lastRebalance: Number(config[5]) * 1000 // Convert to milliseconds
            };
            
        } catch (error) {
            this.logger.error(`Failed to get asset config for ${assetId}:`, error);
            return null;
        }
    }

    /**
     * Check if rebalancing is needed based on current state
     */
    public async checkRebalancingNeeds(): Promise<RebalanceAnalysis> {
        try {
            const yieldData = await this.getAllAssetYields();
            const analysis: RebalanceAnalysis = {
                needsRebalancing: false,
                reasons: [],
                urgency: 'LOW',
                assets: []
            };

            for (const [assetId, data] of Object.entries(yieldData)) {
                const assetConfig = await this.getAssetConfig(assetId);
                if (!assetConfig || !assetConfig.isActive) continue;

                // Check if yield exceeds target significantly
                const excessYield = data.yield - assetConfig.targetYield;
                if (excessYield > this.config.REBALANCE_THRESHOLD) {
                    analysis.needsRebalancing = true;
                    analysis.reasons.push(`${assetId} has excess yield of ${excessYield}bp`);
                    analysis.assets.push(assetId);
                    
                    // Determine urgency
                    if (excessYield > this.config.REBALANCE_THRESHOLD * 3) {
                        analysis.urgency = 'HIGH';
                    } else if (excessYield > this.config.REBALANCE_THRESHOLD * 2) {
                        analysis.urgency = 'MEDIUM';
                    }
                }

                // Check data staleness
                const dataAge = Date.now() - data.timestamp;
                if (dataAge > 3600000) { // 1 hour
                    analysis.reasons.push(`${assetId} data is stale (${Math.round(dataAge / 60000)} minutes old)`);
                    if (analysis.urgency === 'LOW') analysis.urgency = 'MEDIUM';
                }

                // Check confidence score
                if (data.confidence < 70) {
                    analysis.reasons.push(`${assetId} has low confidence score (${data.confidence}%)`);
                }
            }

            return analysis;
            
        } catch (error) {
            this.logger.error('Failed to check rebalancing needs:', error);
            throw error;
        }
    }

    /**
     * Get protocol health metrics
     */
    public async getProtocolHealth(): Promise<ProtocolHealth> {
        try {
            const yieldData = await this.getAllAssetYields();
            const blockNumber = await this.publicClient.getBlockNumber();
            
            let healthyAssets = 0;
            let totalAssets = 0;
            let avgConfidence = 0;
            let oldestDataAge = 0;

            for (const [assetId, data] of Object.entries(yieldData)) {
                totalAssets++;
                
                if (data.isValid && data.confidence > 70) {
                    healthyAssets++;
                }
                
                avgConfidence += data.confidence;
                
                const dataAge = Date.now() - data.timestamp;
                if (dataAge > oldestDataAge) {
                    oldestDataAge = dataAge;
                }
            }

            avgConfidence = totalAssets > 0 ? avgConfidence / totalAssets : 0;
            
            const healthScore = totalAssets > 0 ? (healthyAssets / totalAssets) * 100 : 0;
            
            let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
            if (healthScore < 50 || oldestDataAge > 7200000) { // 2 hours
                status = 'CRITICAL';
            } else if (healthScore < 80 || oldestDataAge > 3600000) { // 1 hour
                status = 'WARNING';
            }

            return {
                status,
                healthScore,
                totalAssets,
                healthyAssets,
                avgConfidence,
                oldestDataAge: oldestDataAge / 1000, // Convert to seconds
                currentBlock: Number(blockNumber),
                lastUpdate: Date.now()
            };
            
        } catch (error) {
            this.logger.error('Failed to get protocol health:', error);
            throw error;
        }
    }

    /**
     * Monitor for specific events
     */
    public async monitorEvents(): Promise<void> {
        // In a real implementation, this would set up event listeners
        // for YieldOptimized, ExcessYieldDistributed, etc.
        this.logger.debug('Event monitoring not implemented in this example');
    }

    /**
     * Convert string to bytes32 format
     */
    private stringToBytes32(str: string): `0x${string}` {
        // Simple implementation - in production would use proper encoding
        const hex = Buffer.from(str, 'utf8').toString('hex').padEnd(64, '0');
        return `0x${hex}` as `0x${string}`;
    }

    /**
     * Get monitoring status
     */
    public isMonitorRunning(): boolean {
        return this.isRunning;
    }

    /**
     * Get last monitoring cycle results
     */
    public async getLastCycleResults(): Promise<MonitoringCycleResult> {
        try {
            const yieldData = await this.getAllAssetYields();
            const protocolHealth = await this.getProtocolHealth();
            const rebalanceAnalysis = await this.checkRebalancingNeeds();

            return {
                timestamp: Date.now(),
                yieldData,
                protocolHealth,
                rebalanceAnalysis,
                success: true
            };
            
        } catch (error) {
            this.logger.error('Failed to get monitoring cycle results:', error);
            return {
                timestamp: Date.now(),
                yieldData: {},
                protocolHealth: null,
                rebalanceAnalysis: null,
                success: false,
                error: error.message
            };
        }
    }
}

// Type definitions
export interface AssetConfig {
    vaultAddress: string;
    targetYield: number;
    supplyCap: string;
    currentSupply: string;
    isActive: boolean;
    lastRebalance: number;
}

export interface RebalanceAnalysis {
    needsRebalancing: boolean;
    reasons: string[];
    urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    assets: string[];
}

export interface ProtocolHealth {
    status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    healthScore: number;
    totalAssets: number;
    healthyAssets: number;
    avgConfidence: number;
    oldestDataAge: number;
    currentBlock: number;
    lastUpdate: number;
}

export interface MonitoringCycleResult {
    timestamp: number;
    yieldData: Record<string, YieldData>;
    protocolHealth: ProtocolHealth | null;
    rebalanceAnalysis: RebalanceAnalysis | null;
    success: boolean;
    error?: string;
}
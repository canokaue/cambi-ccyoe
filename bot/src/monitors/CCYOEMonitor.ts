import { PublicClient } from 'viem';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';

export interface YieldData {
  yield: number;
  confidence: number;
  timestamp: number;
  isValid: boolean;
}

export interface AssetMonitoringData {
  assetId: string;
  currentYield: number;
  targetYield: number;
  deviation: number;
  confidence: number;
  lastUpdate: number;
  isStale: boolean;
  alerts: string[];
}

/**
 * CCYOE Monitor - Monitors yield data and system state
 */
export class CCYOEMonitor {
  private publicClient: PublicClient;
  private config: Config;
  private logger: Logger;
  private isRunning: boolean = false;

  // Contract ABIs
  private readonly CCYOE_ABI = [
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

  private readonly ORACLE_ABI = [
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
    this.logger = logger.child('CCYOEMonitor');
  }

  /**
   * Start monitoring
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Monitor is already running');
      return;
    }

    this.logger.info('Starting CCYOE monitoring...');

    try {
      // Validate contract connectivity
      await this.validateContracts();
      
      this.isRunning = true;
      this.logger.info('CCYOE monitoring started successfully');
    } catch (error) {
      this.logger.error('Failed to start CCYOE monitoring:', error);
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

    this.logger.info('Stopping CCYOE monitoring...');
    this.isRunning = false;
    this.logger.info('CCYOE monitoring stopped');
  }

  /**
   * Validate contract connectivity
   */
  private async validateContracts(): Promise<void> {
    try {
      // Test CCYOE contract
      const ccyoeResult = await this.publicClient.readContract({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: this.CCYOE_ABI,
        functionName: 'getAllAssetYields'
      });

      // Test Oracle contract
      const cmBTCBytes32 = this.stringToBytes32('cmBTC');
      await this.publicClient.readContract({
        address: this.config.ORACLE_ADDRESS as `0x${string}`,
        abi: this.ORACLE_ABI,
        functionName: 'isYieldDataValid',
        args: [cmBTCBytes32]
      });

      this.logger.info('Contract connectivity validated');
    } catch (error) {
      this.logger.error('Contract validation failed:', error);
      throw new Error(`Contract validation failed: ${error}`);
    }
  }

  /**
   * Get all asset yields from oracle
   */
  public async getAllAssetYields(): Promise<Record<string, YieldData>> {
    try {
      const yields: Record<string, YieldData> = {};
      
      for (const assetId of this.config.SUPPORTED_ASSETS) {
        const yieldData = await this.getAssetYield(assetId);
        if (yieldData) {
          yields[assetId] = yieldData;
          
          this.logger.logYieldMonitoring(
            assetId,
            yieldData.yield,
            yieldData.confidence,
            this.calculateDeviation(assetId, yieldData.yield)
          );
        }
      }

      return yields;
    } catch (error) {
      this.logger.error('Failed to get all asset yields:', error);
      throw error;
    }
  }

  /**
   * Get yield data for specific asset
   */
  public async getAssetYield(assetId: string): Promise<YieldData | null> {
    try {
      const assetIdBytes32 = this.stringToBytes32(assetId);
      
      const result = await this.publicClient.readContract({
        address: this.config.ORACLE_ADDRESS as `0x${string}`,
        abi: this.ORACLE_ABI,
        functionName: 'getAssetYieldData',
        args: [assetIdBytes32]
      });

      return {
        yield: Number(result[0]),
        confidence: Number(result[2]),
        timestamp: Number(result[1]) * 1000, // Convert to milliseconds
        isValid: result[3]
      };
    } catch (error) {
      this.logger.error(`Failed to get yield data for ${assetId}:`, error);
      return null;
    }
  }

  /**
   * Get comprehensive monitoring data for all assets
   */
  public async getAssetMonitoringData(): Promise<AssetMonitoringData[]> {
    const monitoringData: AssetMonitoringData[] = [];

    for (const assetId of this.config.SUPPORTED_ASSETS) {
      try {
        const yieldData = await this.getAssetYield(assetId);
        const assetConfig = this.config.getAssetConfig(assetId);
        
        if (!yieldData || !assetConfig) continue;

        const deviation = this.calculateDeviation(assetId, yieldData.yield);
        const isStale = this.isDataStale(assetId, yieldData.timestamp);
        const alerts = this.generateAlerts(assetId, yieldData, deviation, isStale);

        monitoringData.push({
          assetId,
          currentYield: yieldData.yield,
          targetYield: assetConfig.targetYield,
          deviation,
          confidence: yieldData.confidence,
          lastUpdate: yieldData.timestamp,
          isStale,
          alerts
        });
      } catch (error) {
        this.logger.error(`Failed to get monitoring data for ${assetId}:`, error);
      }
    }

    return monitoringData;
  }

  /**
   * Check if rebalancing conditions are met
   */
  public async checkRebalancingConditions(): Promise<{
    shouldRebalance: boolean;
    reason?: string;
    urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    affectedAssets: string[];
  }> {
    try {
      const monitoringData = await this.getAssetMonitoringData();
      const affectedAssets: string[] = [];
      let maxUrgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
      let reasons: string[] = [];

      for (const data of monitoringData) {
        const assetConfig = this.config.getAssetConfig(data.assetId);
        if (!assetConfig) continue;

        // Check yield deviation threshold
        if (Math.abs(data.deviation) > this.config.REBALANCE_THRESHOLD) {
          affectedAssets.push(data.assetId);
          reasons.push(`${data.assetId} yield deviation: ${data.deviation}bp > ${this.config.REBALANCE_THRESHOLD}bp`);
          
          // Determine urgency based on deviation magnitude
          const deviationMagnitude = Math.abs(data.deviation);
          if (deviationMagnitude > this.config.REBALANCE_THRESHOLD * 3) {
            maxUrgency = 'CRITICAL';
          } else if (deviationMagnitude > this.config.REBALANCE_THRESHOLD * 2) {
            maxUrgency = maxUrgency === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
          } else if (deviationMagnitude > this.config.REBALANCE_THRESHOLD * 1.5) {
            maxUrgency = ['CRITICAL', 'HIGH'].includes(maxUrgency) ? maxUrgency : 'MEDIUM';
          }
        }

        // Check confidence thresholds
        if (data.confidence < assetConfig.minConfidence) {
          affectedAssets.push(data.assetId);
          reasons.push(`${data.assetId} low confidence: ${data.confidence}% < ${assetConfig.minConfidence}%`);
          maxUrgency = ['CRITICAL', 'HIGH'].includes(maxUrgency) ? maxUrgency : 'MEDIUM';
        }

        // Check data staleness
        if (data.isStale) {
          affectedAssets.push(data.assetId);
          reasons.push(`${data.assetId} stale data detected`);
          maxUrgency = 'CRITICAL'; // Stale data is always critical
        }
      }

      const shouldRebalance = affectedAssets.length > 0;
      
      return {
        shouldRebalance,
        reason: shouldRebalance ? reasons.join('; ') : undefined,
        urgency: maxUrgency,
        affectedAssets: [...new Set(affectedAssets)] // Remove duplicates
      };
    } catch (error) {
      this.logger.error('Failed to check rebalancing conditions:', error);
      return {
        shouldRebalance: false,
        urgency: 'LOW',
        affectedAssets: []
      };
    }
  }

  /**
   * Get CCYOE contract status
   */
  public async getCCYOEStatus(): Promise<{
    lastGlobalRebalance: number;
    totalExcessYield: number;
    isActive: boolean;
  }> {
    try {
      // These would be additional contract calls to get CCYOE status
      // For now, return mock data
      return {
        lastGlobalRebalance: Date.now() - 3600000, // 1 hour ago
        totalExcessYield: 250, // 2.5% excess yield
        isActive: true
      };
    } catch (error) {
      this.logger.error('Failed to get CCYOE status:', error);
      return {
        lastGlobalRebalance: 0,
        totalExcessYield: 0,
        isActive: false
      };
    }
  }

  /**
   * Calculate yield deviation from target
   */
  private calculateDeviation(assetId: string, currentYield: number): number {
    const assetConfig = this.config.getAssetConfig(assetId);
    if (!assetConfig) return 0;
    
    return currentYield - assetConfig.targetYield;
  }

  /**
   * Check if data is stale
   */
  private isDataStale(assetId: string, timestamp: number): boolean {
    const assetConfig = this.config.getAssetConfig(assetId);
    if (!assetConfig) return false;
    
    const dataAge = Date.now() - timestamp;
    return dataAge > assetConfig.alertThresholds.staleness * 1000;
  }

  /**
   * Generate alerts for asset monitoring data
   */
  private generateAlerts(assetId: string, yieldData: YieldData, deviation: number, isStale: boolean): string[] {
    const alerts: string[] = [];
    const assetConfig = this.config.getAssetConfig(assetId);
    
    if (!assetConfig) return alerts;

    // Yield deviation alerts
    if (Math.abs(deviation) > assetConfig.alertThresholds.yield) {
      alerts.push(`High yield deviation: ${deviation}bp`);
    }

    // Confidence alerts
    if (yieldData.confidence < assetConfig.alertThresholds.confidence) {
      alerts.push(`Low confidence: ${yieldData.confidence}%`);
    }

    // Staleness alerts
    if (isStale) {
      const ageMinutes = Math.round((Date.now() - yieldData.timestamp) / 60000);
      alerts.push(`Stale data: ${ageMinutes} minutes old`);
    }

    // Validity alerts
    if (!yieldData.isValid) {
      alerts.push('Invalid yield data');
    }

    return alerts;
  }

  /**
   * Convert string to bytes32 format
   */
  private stringToBytes32(str: string): `0x${string}` {
    // Simple conversion - in production, use proper keccak256 hashing
    const hex = Buffer.from(str, 'utf8').toString('hex');
    return `0x${hex.padEnd(64, '0')}` as `0x${string}`;
  }

  /**
   * Get monitoring summary
   */
  public async getMonitoringSummary(): Promise<{
    totalAssets: number;
    healthyAssets: number;
    alertsActive: number;
    lastUpdate: number;
    averageConfidence: number;
  }> {
    try {
      const monitoringData = await this.getAssetMonitoringData();
      
      const totalAssets = monitoringData.length;
      const healthyAssets = monitoringData.filter(d => d.alerts.length === 0).length;
      const totalAlerts = monitoringData.reduce((sum, d) => sum + d.alerts.length, 0);
      const lastUpdate = Math.max(...monitoringData.map(d => d.lastUpdate));
      const averageConfidence = monitoringData.reduce((sum, d) => sum + d.confidence, 0) / totalAssets;

      return {
        totalAssets,
        healthyAssets,
        alertsActive: totalAlerts,
        lastUpdate,
        averageConfidence: Math.round(averageConfidence)
      };
    } catch (error) {
      this.logger.error('Failed to get monitoring summary:', error);
      return {
        totalAssets: 0,
        healthyAssets: 0,
        alertsActive: 0,
        lastUpdate: 0,
        averageConfidence: 0
      };
    }
  }

  /**
   * Check if monitor is running
   */
  public isMonitoringActive(): boolean {
    return this.isRunning;
  }
}

export default CCYOEMonitor;

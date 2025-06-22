import { PublicClient } from 'viem';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';

export interface ComponentHealth {
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  lastCheck: number;
  details?: any;
}

export interface SystemHealth {
  status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'ERROR';
  components: Record<string, ComponentHealth>;
  lastUpdate: number;
  uptime: number;
}

/**
 * Health Monitor - Monitors system health across all components
 */
export class HealthMonitor {
  private publicClient: PublicClient;
  private config: Config;
  private logger: Logger;
  private isRunning: boolean = false;
  private startTime: number;
  private healthChecks: Map<string, () => Promise<ComponentHealth>> = new Map();

  constructor(publicClient: PublicClient, config: Config, logger: Logger) {
    this.publicClient = publicClient;
    this.config = config;
    this.logger = logger.child('HealthMonitor');
    this.startTime = Date.now();
    this.initializeHealthChecks();
  }

  /**
   * Initialize health check functions
   */
  private initializeHealthChecks(): void {
    // Blockchain connectivity check
    this.healthChecks.set('blockchain', async () => {
      try {
        const blockNumber = await this.publicClient.getBlockNumber();
        const latestBlock = await this.publicClient.getBlock({ blockNumber });
        const blockAge = Date.now() - Number(latestBlock.timestamp) * 1000;
        
        return {
          status: blockAge < 30000 ? 'HEALTHY' : blockAge < 60000 ? 'WARNING' : 'CRITICAL',
          lastCheck: Date.now(),
          details: {
            blockNumber: Number(blockNumber),
            blockAge: Math.round(blockAge / 1000),
            timestamp: latestBlock.timestamp
          }
        };
      } catch (error) {
        return {
          status: 'CRITICAL',
          lastCheck: Date.now(),
          details: { error: error.toString() }
        };
      }
    });

    // Contract connectivity check
    this.healthChecks.set('contracts', async () => {
      try {
        const results = await Promise.allSettled([
          this.checkCCYOEContract(),
          this.checkOracleContract()
        ]);

        const failures = results.filter(r => r.status === 'rejected').length;
        const criticals = results
          .filter(r => r.status === 'fulfilled')
          .filter(r => r.value.status === 'CRITICAL').length;

        let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
        if (failures > 0 || criticals > 0) {
          status = 'CRITICAL';
        } else if (results.some(r => r.status === 'fulfilled' && r.value.status === 'WARNING')) {
          status = 'WARNING';
        }

        return {
          status,
          lastCheck: Date.now(),
          details: {
            ccyoe: results[0].status === 'fulfilled' ? results[0].value : { error: true },
            oracle: results[1].status === 'fulfilled' ? results[1].value : { error: true }
          }
        };
      } catch (error) {
        return {
          status: 'CRITICAL',
          lastCheck: Date.now(),
          details: { error: error.toString() }
        };
      }
    });

    // Gas price check
    this.healthChecks.set('gas', async () => {
      try {
        const feeData = await this.publicClient.estimateFeesPerGas();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || BigInt(0);
        const gasPriceGwei = Number(gasPrice) / 1e9;

        let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
        if (gasPriceGwei > this.config.GAS_PRICE_THRESHOLD * 2) {
          status = 'CRITICAL';
        } else if (gasPriceGwei > this.config.GAS_PRICE_THRESHOLD) {
          status = 'WARNING';
        }

        return {
          status,
          lastCheck: Date.now(),
          details: {
            gasPrice: gasPriceGwei,
            threshold: this.config.GAS_PRICE_THRESHOLD,
            maxFeePerGas: feeData.maxFeePerGas ? Number(feeData.maxFeePerGas) / 1e9 : null,
            baseFeePerGas: feeData.baseFeePerGas ? Number(feeData.baseFeePerGas) / 1e9 : null
          }
        };
      } catch (error) {
        return {
          status: 'WARNING',
          lastCheck: Date.now(),
          details: { error: error.toString() }
        };
      }
    });

    // Account balance check
    this.healthChecks.set('balance', async () => {
      try {
        const balance = await this.publicClient.getBalance({
          address: this.config.PRIVATE_KEY.startsWith('0x') ? 
            `0x${this.config.PRIVATE_KEY.slice(2, 42)}` as `0x${string}` :
            this.config.PRIVATE_KEY as `0x${string}`
        });

        const balanceEth = Number(balance) / 1e18;
        const minBalance = 0.01; // Minimum 0.01 ETH

        let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
        if (balanceEth < minBalance) {
          status = 'CRITICAL';
        } else if (balanceEth < minBalance * 2) {
          status = 'WARNING';
        }

        return {
          status,
          lastCheck: Date.now(),
          details: {
            balance: balanceEth,
            minBalance,
            wei: balance.toString()
          }
        };
      } catch (error) {
        return {
          status: 'WARNING',
          lastCheck: Date.now(),
          details: { error: error.toString() }
        };
      }
    });

    // System resource check
    this.healthChecks.set('system', async () => {
      try {
        const memUsage = process.memoryUsage();
        const uptime = process.uptime();
        const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const memLimitMB = Math.round(memUsage.heapTotal / 1024 / 1024);

        let status: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';
        if (memUsageMB > 500) { // More than 500MB
          status = 'WARNING';
        }
        if (memUsageMB > 1000) { // More than 1GB
          status = 'CRITICAL';
        }

        return {
          status,
          lastCheck: Date.now(),
          details: {
            memoryUsageMB: memUsageMB,
            memoryLimitMB: memLimitMB,
            uptimeSeconds: Math.round(uptime),
            nodeVersion: process.version,
            platform: process.platform
          }
        };
      } catch (error) {
        return {
          status: 'WARNING',
          lastCheck: Date.now(),
          details: { error: error.toString() }
        };
      }
    });

    this.logger.info(`Initialized ${this.healthChecks.size} health checks`);
  }

  /**
   * Start health monitoring
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Health monitor is already running');
      return;
    }

    this.logger.info('Starting health monitor...');
    this.isRunning = true;

    // Perform initial health check
    await this.performHealthCheck();

    // Schedule regular health checks
    setInterval(async () => {
      if (this.isRunning) {
        await this.performHealthCheck();
      }
    }, this.config.HEALTH_CHECK_INTERVAL * 1000);

    this.logger.info('Health monitor started successfully');
  }

  /**
   * Stop health monitoring
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Health monitor is not running');
      return;
    }

    this.logger.info('Stopping health monitor...');
    this.isRunning = false;
    this.logger.info('Health monitor stopped');
  }

  /**
   * Perform comprehensive health check
   */
  private async performHealthCheck(): Promise<void> {
    try {
      const healthResults: Record<string, ComponentHealth> = {};
      
      // Run all health checks in parallel
      const promises = Array.from(this.healthChecks.entries()).map(async ([name, check]) => {
        try {
          const result = await check();
          healthResults[name] = result;
          
          this.logger.logHealthCheck(name, result.status, result.details);
          return { name, result };
        } catch (error) {
          const errorResult: ComponentHealth = {
            status: 'CRITICAL',
            lastCheck: Date.now(),
            details: { error: error.toString() }
          };
          healthResults[name] = errorResult;
          this.logger.logHealthCheck(name, 'CRITICAL', { error: error.toString() });
          return { name, result: errorResult };
        }
      });

      await Promise.allSettled(promises);

      // Log overall health summary
      const criticals = Object.values(healthResults).filter(h => h.status === 'CRITICAL').length;
      const warnings = Object.values(healthResults).filter(h => h.status === 'WARNING').length;
      
      this.logger.debug('Health check completed', {
        total: Object.keys(healthResults).length,
        healthy: Object.keys(healthResults).length - criticals - warnings,
        warnings,
        criticals
      });

    } catch (error) {
      this.logger.error('Health check failed:', error);
    }
  }

  /**
   * Get full health status
   */
  public async getFullHealthStatus(): Promise<SystemHealth> {
    const components: Record<string, ComponentHealth> = {};
    
    // Get current health for all components
    for (const [name, check] of this.healthChecks.entries()) {
      try {
        components[name] = await check();
      } catch (error) {
        components[name] = {
          status: 'CRITICAL',
          lastCheck: Date.now(),
          details: { error: error.toString() }
        };
      }
    }

    // Determine overall system status
    const criticals = Object.values(components).filter(c => c.status === 'CRITICAL').length;
    const warnings = Object.values(components).filter(c => c.status === 'WARNING').length;

    let overallStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'ERROR' = 'HEALTHY';
    if (criticals > 0) {
      overallStatus = 'CRITICAL';
    } else if (warnings > 0) {
      overallStatus = 'WARNING';
    }

    return {
      status: overallStatus,
      components,
      lastUpdate: Date.now(),
      uptime: Date.now() - this.startTime
    };
  }

  /**
   * Check CCYOE contract health
   */
  private async checkCCYOEContract(): Promise<ComponentHealth> {
    try {
      // Test contract call
      const result = await this.publicClient.readContract({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: [{
          name: 'getAllAssetYields',
          type: 'function',
          stateMutability: 'view',
          inputs: [],
          outputs: [
            { name: 'yields', type: 'uint256[]' },
            { name: 'vaults', type: 'address[]' }
          ]
        }],
        functionName: 'getAllAssetYields'
      });

      return {
        status: 'HEALTHY',
        lastCheck: Date.now(),
        details: {
          address: this.config.CCYOE_CORE_ADDRESS,
          responsive: true,
          assetCount: result[0].length
        }
      };
    } catch (error) {
      return {
        status: 'CRITICAL',
        lastCheck: Date.now(),
        details: {
          address: this.config.CCYOE_CORE_ADDRESS,
          error: error.toString()
        }
      };
    }
  }

  /**
   * Check Oracle contract health
   */
  private async checkOracleContract(): Promise<ComponentHealth> {
    try {
      // Test oracle contract call
      const cmBTCBytes32 = this.stringToBytes32('cmBTC');
      const result = await this.publicClient.readContract({
        address: this.config.ORACLE_ADDRESS as `0x${string}`,
        abi: [{
          name: 'isYieldDataValid',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: 'assetId', type: 'bytes32' }],
          outputs: [{ name: '', type: 'bool' }]
        }],
        functionName: 'isYieldDataValid',
        args: [cmBTCBytes32]
      });

      return {
        status: 'HEALTHY',
        lastCheck: Date.now(),
        details: {
          address: this.config.ORACLE_ADDRESS,
          responsive: true,
          cmBTCValid: result
        }
      };
    } catch (error) {
      return {
        status: 'CRITICAL',
        lastCheck: Date.now(),
        details: {
          address: this.config.ORACLE_ADDRESS,
          error: error.toString()
        }
      };
    }
  }

  /**
   * Convert string to bytes32 format
   */
  private stringToBytes32(str: string): `0x${string}` {
    const hex = Buffer.from(str, 'utf8').toString('hex');
    return `0x${hex.padEnd(64, '0')}` as `0x${string}`;
  }

  /**
   * Get simplified health status
   */
  public async getHealthSummary(): Promise<{
    status: string;
    uptime: number;
    criticalIssues: number;
    warnings: number;
    lastCheck: number;
  }> {
    const fullHealth = await this.getFullHealthStatus();
    const criticals = Object.values(fullHealth.components).filter(c => c.status === 'CRITICAL').length;
    const warnings = Object.values(fullHealth.components).filter(c => c.status === 'WARNING').length;

    return {
      status: fullHealth.status,
      uptime: fullHealth.uptime,
      criticalIssues: criticals,
      warnings,
      lastCheck: fullHealth.lastUpdate
    };
  }

  /**
   * Check if system is healthy
   */
  public async isSystemHealthy(): Promise<boolean> {
    const health = await this.getFullHealthStatus();
    return health.status === 'HEALTHY' || health.status === 'WARNING';
  }
}

export default HealthMonitor;

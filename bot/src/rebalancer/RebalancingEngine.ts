import { PublicClient, WalletClient, Account, parseGwei, formatEther } from 'viem';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';
import { YieldData } from '../monitors/CCYOEMonitor';

export interface RebalanceRequired {
  required: boolean;
  reason: string;
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  assets: string[];
  data?: any;
}

export interface RebalanceResult {
  success: boolean;
  txHash?: string;
  gasUsed?: number;
  gasPrice?: string;
  error?: string;
}

/**
 * Rebalancing Engine - Handles CCYOE rebalancing operations
 */
export class RebalancingEngine {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private account: Account;
  private config: Config;
  private logger: Logger;

  // Contract ABIs
  private readonly CCYOE_ABI = [
    {
      name: 'optimizeYields',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: []
    },
    {
      name: 'emergencyRebalance',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [
        { name: 'assetId', type: 'bytes32' },
        { name: 'newYield', type: 'uint256' },
        { name: 'reason', type: 'string' }
      ],
      outputs: []
    },
    {
      name: 'pause',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: []
    },
    {
      name: 'unpause',
      type: 'function',
      stateMutability: 'nonpayable',
      inputs: [],
      outputs: []
    }
  ] as const;

  constructor(
    publicClient: PublicClient,
    walletClient: WalletClient,
    account: Account,
    config: Config,
    logger: Logger
  ) {
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.account = account;
    this.config = config;
    this.logger = logger.child('RebalancingEngine');
  }

  /**
   * Check if rebalancing should be executed
   */
  public async shouldRebalance(currentYields: Map<string, YieldData>): Promise<RebalanceRequired> {
    try {
      const reasons: string[] = [];
      const affectedAssets: string[] = [];
      let maxUrgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';

      // Check each asset for rebalancing conditions
      for (const [assetId, yieldData] of currentYields.entries()) {
        const assetConfig = this.config.getAssetConfig(assetId);
        if (!assetConfig) continue;

        const deviation = Math.abs(yieldData.yield - assetConfig.targetYield);
        
        // Check if deviation exceeds threshold
        if (deviation > this.config.REBALANCE_THRESHOLD) {
          affectedAssets.push(assetId);
          reasons.push(`${assetId}: ${deviation}bp deviation from target`);
          
          // Determine urgency
          if (deviation > this.config.REBALANCE_THRESHOLD * 3) {
            maxUrgency = 'CRITICAL';
          } else if (deviation > this.config.REBALANCE_THRESHOLD * 2) {
            maxUrgency = maxUrgency === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
          } else if (deviation > this.config.REBALANCE_THRESHOLD * 1.5) {
            maxUrgency = ['CRITICAL', 'HIGH'].includes(maxUrgency) ? maxUrgency : 'MEDIUM';
          }
        }

        // Check confidence levels
        if (yieldData.confidence < assetConfig.minConfidence) {
          affectedAssets.push(assetId);
          reasons.push(`${assetId}: Low confidence ${yieldData.confidence}%`);
          maxUrgency = ['CRITICAL', 'HIGH'].includes(maxUrgency) ? maxUrgency : 'MEDIUM';
        }

        // Check data staleness
        const dataAge = Date.now() - yieldData.timestamp;
        if (dataAge > assetConfig.alertThresholds.staleness * 1000) {
          affectedAssets.push(assetId);
          reasons.push(`${assetId}: Stale data (${Math.round(dataAge / 1000)}s old)`);
          maxUrgency = 'CRITICAL';
        }
      }

      // Calculate total excess yield for optimization trigger
      const totalExcessYield = this.calculateTotalExcessYield(currentYields);
      if (totalExcessYield > this.config.REBALANCE_THRESHOLD) {
        reasons.push(`Total excess yield: ${totalExcessYield}bp`);
        maxUrgency = maxUrgency === 'LOW' ? 'MEDIUM' : maxUrgency;
      }

      const required = affectedAssets.length > 0 || totalExcessYield > this.config.REBALANCE_THRESHOLD;

      return {
        required,
        reason: required ? reasons.join('; ') : 'No rebalancing needed',
        urgency: maxUrgency,
        assets: [...new Set(affectedAssets)], // Remove duplicates
        data: {
          totalExcessYield,
          yieldDeviations: this.calculateYieldDeviations(currentYields)
        }
      };
    } catch (error) {
      this.logger.error('Error checking rebalancing conditions:', error);
      return {
        required: false,
        reason: `Error: ${error}`,
        urgency: 'LOW',
        assets: []
      };
    }
  }

  /**
   * Execute rebalancing operation
   */
  public async executeRebalancing(rebalanceData: RebalanceRequired): Promise<RebalanceResult> {
    try {
      this.logger.info('Executing rebalancing operation', {
        reason: rebalanceData.reason,
        urgency: rebalanceData.urgency,
        assets: rebalanceData.assets
      });

      // Check gas price before execution
      const gasPrice = await this.getOptimalGasPrice();
      if (gasPrice > parseGwei(this.config.GAS_PRICE_THRESHOLD.toString())) {
        throw new Error(`Gas price too high: ${formatEther(gasPrice)} ETH`);
      }

      // Execute the optimization
      const txHash = await this.walletClient.writeContract({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: this.CCYOE_ABI,
        functionName: 'optimizeYields',
        account: this.account,
        gasPrice
      });

      this.logger.logTransaction(txHash, 'CCYOE Rebalancing', undefined, gasPrice.toString());

      // Wait for transaction confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 120_000 // 2 minutes timeout
      });

      const result: RebalanceResult = {
        success: receipt.status === 'success',
        txHash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
        gasPrice: gasPrice.toString()
      };

      if (result.success) {
        this.logger.logRebalancing(
          rebalanceData.reason,
          txHash,
          result.gasUsed || 0,
          result.gasPrice || '0'
        );
      } else {
        result.error = 'Transaction failed';
        this.logger.error('Rebalancing transaction failed', { txHash, receipt });
      }

      return result;

    } catch (error) {
      this.logger.error('Rebalancing execution failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Emergency pause the protocol
   */
  public async emergencyPause(reason: string): Promise<RebalanceResult> {
    try {
      this.logger.logEmergency('Emergency Pause', reason, 'RebalancingEngine');

      const gasPrice = await this.getOptimalGasPrice();
      
      const txHash = await this.walletClient.writeContract({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: this.CCYOE_ABI,
        functionName: 'pause',
        account: this.account,
        gasPrice
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000 // 1 minute timeout for emergency
      });

      return {
        success: receipt.status === 'success',
        txHash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
        gasPrice: gasPrice.toString()
      };

    } catch (error) {
      this.logger.error('Emergency pause failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Emergency unpause the protocol
   */
  public async emergencyUnpause(reason: string): Promise<RebalanceResult> {
    try {
      this.logger.info('Emergency unpause requested', { reason });

      const gasPrice = await this.getOptimalGasPrice();
      
      const txHash = await this.walletClient.writeContract({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: this.CCYOE_ABI,
        functionName: 'unpause',
        account: this.account,
        gasPrice
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000
      });

      return {
        success: receipt.status === 'success',
        txHash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
        gasPrice: gasPrice.toString()
      };

    } catch (error) {
      this.logger.error('Emergency unpause failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Emergency rebalance for specific asset
   */
  public async emergencyRebalanceAsset(
    assetId: string,
    newYield: number,
    reason: string
  ): Promise<RebalanceResult> {
    try {
      this.logger.logEmergency(
        'Emergency Asset Rebalance',
        reason,
        'RebalancingEngine',
        `${assetId}: ${newYield}bp`
      );

      const assetIdBytes32 = this.stringToBytes32(assetId);
      const gasPrice = await this.getOptimalGasPrice();
      
      const txHash = await this.walletClient.writeContract({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: this.CCYOE_ABI,
        functionName: 'emergencyRebalance',
        args: [assetIdBytes32, BigInt(newYield), reason],
        account: this.account,
        gasPrice
      });

      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000
      });

      return {
        success: receipt.status === 'success',
        txHash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : undefined,
        gasPrice: gasPrice.toString()
      };

    } catch (error) {
      this.logger.error(`Emergency rebalance failed for ${assetId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Get optimal gas price for transactions
   */
  private async getOptimalGasPrice(): Promise<bigint> {
    try {
      const feeData = await this.publicClient.estimateFeesPerGas();
      
      // Use legacy gas price if available, otherwise use base fee
      if (feeData.gasPrice) {
        return feeData.gasPrice;
      } else if (feeData.maxFeePerGas) {
        return feeData.maxFeePerGas;
      } else {
        // Fallback to a reasonable default
        return parseGwei('20');
      }
    } catch (error) {
      this.logger.warn('Failed to get optimal gas price, using default:', error);
      return parseGwei('20');
    }
  }

  /**
   * Calculate total excess yield across all assets
   */
  private calculateTotalExcessYield(currentYields: Map<string, YieldData>): number {
    let totalExcess = 0;

    for (const [assetId, yieldData] of currentYields.entries()) {
      const assetConfig = this.config.getAssetConfig(assetId);
      if (!assetConfig) continue;

      const excess = Math.max(0, yieldData.yield - assetConfig.targetYield);
      totalExcess += excess;
    }

    return totalExcess;
  }

  /**
   * Calculate yield deviations for all assets
   */
  private calculateYieldDeviations(currentYields: Map<string, YieldData>): Record<string, number> {
    const deviations: Record<string, number> = {};

    for (const [assetId, yieldData] of currentYields.entries()) {
      const assetConfig = this.config.getAssetConfig(assetId);
      if (!assetConfig) continue;

      deviations[assetId] = yieldData.yield - assetConfig.targetYield;
    }

    return deviations;
  }

  /**
   * Convert string to bytes32 format
   */
  private stringToBytes32(str: string): `0x${string}` {
    const hex = Buffer.from(str, 'utf8').toString('hex');
    return `0x${hex.padEnd(64, '0')}` as `0x${string}`;
  }

  /**
   * Estimate gas for rebalancing operation
   */
  public async estimateRebalancingGas(): Promise<bigint> {
    try {
      const gasEstimate = await this.publicClient.estimateContractGas({
        address: this.config.CCYOE_CORE_ADDRESS as `0x${string}`,
        abi: this.CCYOE_ABI,
        functionName: 'optimizeYields',
        account: this.account
      });

      // Add 20% buffer to gas estimate
      return gasEstimate + (gasEstimate * BigInt(20)) / BigInt(100);
    } catch (error) {
      this.logger.warn('Failed to estimate gas, using default:', error);
      return BigInt(150000); // Default gas limit
    }
  }

  /**
   * Check account balance and gas affordability
   */
  public async checkGasAffordability(): Promise<{
    canAfford: boolean;
    balance: string;
    estimatedCost: string;
    message: string;
  }> {
    try {
      const balance = await this.publicClient.getBalance({
        address: this.account.address
      });

      const gasEstimate = await this.estimateRebalancingGas();
      const gasPrice = await this.getOptimalGasPrice();
      const estimatedCost = gasEstimate * gasPrice;

      const canAfford = balance > estimatedCost;

      return {
        canAfford,
        balance: formatEther(balance),
        estimatedCost: formatEther(estimatedCost),
        message: canAfford 
          ? 'Sufficient balance for rebalancing'
          : 'Insufficient balance for rebalancing'
      };
    } catch (error) {
      this.logger.error('Failed to check gas affordability:', error);
      return {
        canAfford: false,
        balance: '0',
        estimatedCost: '0',
        message: `Error checking balance: ${error}`
      };
    }
  }

  /**
   * Get rebalancing statistics
   */
  public getRebalancingStats(): {
    lastRebalance: number;
    totalRebalances: number;
    successRate: number;
    avgGasUsed: number;
  } {
    // In production, this would track actual statistics
    return {
      lastRebalance: Date.now() - 3600000, // 1 hour ago
      totalRebalances: 42,
      successRate: 98.5,
      avgGasUsed: 145000
    };
  }
}

export default RebalancingEngine;

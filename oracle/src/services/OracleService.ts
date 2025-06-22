import { ethers } from 'ethers';
import { Logger } from '../utils/Logger';
import { Config } from '../config/Config';

export interface AssetYield {
  assetId: string;
  yield: number;
  confidence: number;
  timestamp: number;
  isValid: boolean;
}

export interface OracleHealth {
  isConnected: boolean;
  lastTransaction: string;
  gasPrice: string;
  blockNumber: number;
  contractsReachable: boolean;
}

export interface TransactionResult {
  txHash: string;
  gasUsed: number;
  gasPrice: string;
  success: boolean;
  blockNumber?: number;
}

/**
 * Oracle Service for blockchain interactions
 * Handles smart contract communication for yield data submission
 */
export class OracleService {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private config: Config;
  private logger: Logger;
  private oracleContract?: ethers.Contract;
  private ccyoeContract?: ethers.Contract;

  // Contract ABIs (simplified for core functions)
  private readonly ORACLE_ABI = [
    "function updateAssetYield(bytes32 assetId, uint256 yield, uint256 confidence) external",
    "function getAssetYield(bytes32 assetId) external view returns (uint256 yield, uint256 confidence, uint256 timestamp, bool isValid)",
    "function isYieldDataValid(bytes32 assetId) external view returns (bool)",
    "function getLastUpdate(bytes32 assetId) external view returns (uint256)",
    "function emergencySetYield(bytes32 assetId, uint256 yield) external",
    "function pause() external",
    "function unpause() external",
    "function setHeartbeat(bytes32 assetId, uint256 heartbeat) external",
    "event YieldUpdated(bytes32 indexed assetId, uint256 yield, uint256 confidence, uint256 timestamp)",
    "event EmergencyYieldSet(bytes32 indexed assetId, uint256 yield, string reason)"
  ];

  private readonly CCYOE_ABI = [
    "function optimizeYields() external",
    "function getAssetConfig(bytes32 assetId) external view returns (address vaultAddress, uint256 targetYield, uint256 supplyCap, uint256 currentSupply, bool isActive, uint256 lastRebalance)",
    "function getAllAssetYields() external view returns (uint256[] memory yields, address[] memory vaults)"
  ];

  constructor(provider: ethers.Provider, signer: ethers.Signer, config: Config) {
    this.provider = provider;
    this.signer = signer;
    this.config = config;
    this.logger = new Logger('OracleService');

    this.initializeContracts();
  }

  /**
   * Initialize smart contract instances
   */
  private async initializeContracts(): Promise<void> {
    try {
      if (this.config.ORACLE_CONTRACT_ADDRESS) {
        this.oracleContract = new ethers.Contract(
          this.config.ORACLE_CONTRACT_ADDRESS,
          this.ORACLE_ABI,
          this.signer
        );
        this.logger.info(`Oracle contract initialized at ${this.config.ORACLE_CONTRACT_ADDRESS}`);
      }

      if (this.config.CCYOE_CORE_ADDRESS) {
        this.ccyoeContract = new ethers.Contract(
          this.config.CCYOE_CORE_ADDRESS,
          this.CCYOE_ABI,
          this.signer
        );
        this.logger.info(`CCYOE contract initialized at ${this.config.CCYOE_CORE_ADDRESS}`);
      }

    } catch (error) {
      this.logger.error('Failed to initialize contracts', error);
    }
  }

  /**
   * Submit yield data to the oracle contract
   */
  public async submitYieldData(
    assetId: string,
    yield: number,
    confidence: number
  ): Promise<TransactionResult | null> {
    try {
      if (!this.oracleContract) {
        throw new Error('Oracle contract not initialized');
      }

      const assetIdBytes32 = ethers.id(assetId);
      
      this.logger.debug(`Submitting yield data for ${assetId}`, {
        yield,
        confidence,
        assetIdBytes32
      });

      // Check gas price
      const gasPrice = await this.getOptimalGasPrice();
      if (gasPrice && gasPrice > this.config.MAX_GAS_PRICE * 1e9) {
        this.logger.warn('Gas price too high, skipping update', {
          currentGasPrice: gasPrice / 1e9,
          maxGasPrice: this.config.MAX_GAS_PRICE
        });
        return null;
      }

      // Estimate gas
      const estimatedGas = await this.oracleContract.updateAssetYield.estimateGas(
        assetIdBytes32,
        yield,
        confidence
      );

      // Add 20% buffer to gas estimate
      const gasLimit = Math.floor(Number(estimatedGas) * 1.2);

      // Submit transaction
      const tx = await this.oracleContract.updateAssetYield(
        assetIdBytes32,
        yield,
        confidence,
        {
          gasLimit,
          gasPrice
        }
      );

      this.logger.logTransaction(tx.hash, `Update yield for ${assetId}`, undefined, gasPrice?.toString());

      // Wait for confirmation
      const receipt = await tx.wait();

      const result: TransactionResult = {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : 0,
        gasPrice: gasPrice?.toString() || '0',
        success: receipt.status === 1,
        blockNumber: receipt.blockNumber
      };

      if (result.success) {
        this.logger.info(`Successfully updated yield for ${assetId}`, {
          txHash: result.txHash,
          gasUsed: result.gasUsed,
          blockNumber: result.blockNumber
        });
      } else {
        this.logger.error(`Transaction failed for ${assetId}`, { txHash: result.txHash });
      }

      return result;

    } catch (error) {
      this.logger.error(`Failed to submit yield data for ${assetId}`, error, {
        yield,
        confidence
      });
      return null;
    }
  }

  /**
   * Get current yield data for an asset
   */
  public async getAssetYield(assetId: string): Promise<AssetYield | null> {
    try {
      if (!this.oracleContract) {
        throw new Error('Oracle contract not initialized');
      }

      const assetIdBytes32 = ethers.id(assetId);
      const result = await this.oracleContract.getAssetYield(assetIdBytes32);

      return {
        assetId,
        yield: Number(result.yield),
        confidence: Number(result.confidence),
        timestamp: Number(result.timestamp) * 1000, // Convert to milliseconds
        isValid: result.isValid
      };

    } catch (error) {
      this.logger.error(`Failed to get yield data for ${assetId}`, error);
      return null;
    }
  }

  /**
   * Check if yield data is valid and fresh
   */
  public async isYieldDataValid(assetId: string): Promise<boolean> {
    try {
      if (!this.oracleContract) {
        return false;
      }

      const assetIdBytes32 = ethers.id(assetId);
      return await this.oracleContract.isYieldDataValid(assetIdBytes32);

    } catch (error) {
      this.logger.error(`Failed to check yield data validity for ${assetId}`, error);
      return false;
    }
  }

  /**
   * Trigger CCYOE optimization
   */
  public async triggerOptimization(): Promise<TransactionResult | null> {
    try {
      if (!this.ccyoeContract) {
        throw new Error('CCYOE contract not initialized');
      }

      this.logger.info('Triggering CCYOE optimization');

      const gasPrice = await this.getOptimalGasPrice();
      const estimatedGas = await this.ccyoeContract.optimizeYields.estimateGas();
      const gasLimit = Math.floor(Number(estimatedGas) * 1.2);

      const tx = await this.ccyoeContract.optimizeYields({
        gasLimit,
        gasPrice
      });

      this.logger.logTransaction(tx.hash, 'CCYOE Optimization', undefined, gasPrice?.toString());

      const receipt = await tx.wait();

      const result: TransactionResult = {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : 0,
        gasPrice: gasPrice?.toString() || '0',
        success: receipt.status === 1,
        blockNumber: receipt.blockNumber
      };

      if (result.success) {
        this.logger.info('CCYOE optimization completed successfully', {
          txHash: result.txHash,
          gasUsed: result.gasUsed
        });
      } else {
        this.logger.error('CCYOE optimization failed', { txHash: result.txHash });
      }

      return result;

    } catch (error) {
      this.logger.error('Failed to trigger CCYOE optimization', error);
      return null;
    }
  }

  /**
   * Emergency yield override
   */
  public async emergencySetYield(
    assetId: string,
    yield: number,
    reason: string
  ): Promise<TransactionResult | null> {
    try {
      if (!this.oracleContract) {
        throw new Error('Oracle contract not initialized');
      }

      this.logger.logEmergency('Emergency yield set', reason, 'OracleService', {
        assetId,
        yield
      });

      const assetIdBytes32 = ethers.id(assetId);
      const gasPrice = await this.getOptimalGasPrice();
      
      const tx = await this.oracleContract.emergencySetYield(
        assetIdBytes32,
        yield,
        { gasPrice }
      );

      const receipt = await tx.wait();

      return {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : 0,
        gasPrice: gasPrice?.toString() || '0',
        success: receipt.status === 1,
        blockNumber: receipt.blockNumber
      };

    } catch (error) {
      this.logger.error(`Failed to set emergency yield for ${assetId}`, error);
      return null;
    }
  }

  /**
   * Get optimal gas price
   */
  private async getOptimalGasPrice(): Promise<bigint | null> {
    try {
      // Get current gas price from network
      const feeData = await this.provider.getFeeData();
      
      if (feeData.gasPrice) {
        return feeData.gasPrice;
      }

      // Fallback to legacy gas price
      return await this.provider.getGasPrice();

    } catch (error) {
      this.logger.error('Failed to get gas price', error);
      return null;
    }
  }

  /**
   * Get comprehensive system health status
   */
  public async getHealth(): Promise<OracleHealth> {
    try {
      const [blockNumber, gasPrice] = await Promise.all([
        this.provider.getBlockNumber(),
        this.getOptimalGasPrice()
      ]);

      // Test contract connectivity
      let contractsReachable = false;
      try {
        if (this.oracleContract && this.config.SUPPORTED_ASSETS.length > 0) {
          const assetIdBytes32 = ethers.id(this.config.SUPPORTED_ASSETS[0]);
          await this.oracleContract.isYieldDataValid(assetIdBytes32);
          contractsReachable = true;
        }
      } catch (error) {
        this.logger.debug('Contract health check failed', error);
      }

      return {
        isConnected: true,
        lastTransaction: '', // This would be tracked separately
        gasPrice: gasPrice?.toString() || '0',
        blockNumber,
        contractsReachable
      };

    } catch (error) {
      this.logger.error('Health check failed', error);
      return {
        isConnected: false,
        lastTransaction: '',
        gasPrice: '0',
        blockNumber: 0,
        contractsReachable: false
      };
    }
  }

  /**
   * Get all asset yields from CCYOE contract
   */
  public async getAllAssetYields(): Promise<{ assetId: string, yield: number }[]> {
    try {
      if (!this.ccyoeContract) {
        throw new Error('CCYOE contract not initialized');
      }

      const [yields, vaults] = await this.ccyoeContract.getAllAssetYields();
      const assetIds = this.config.getAllAssetIds();

      return assetIds.map((assetId, index) => ({
        assetId,
        yield: yields[index] ? Number(yields[index]) : 0
      }));

    } catch (error) {
      this.logger.error('Failed to get all asset yields', error);
      return [];
    }
  }

  /**
   * Pause oracle updates
   */
  public async pauseOracle(): Promise<TransactionResult | null> {
    try {
      if (!this.oracleContract) {
        throw new Error('Oracle contract not initialized');
      }

      this.logger.logEmergency('Oracle pause', 'Manual pause requested', 'OracleService');

      const tx = await this.oracleContract.pause();
      const receipt = await tx.wait();

      return {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : 0,
        gasPrice: (await this.getOptimalGasPrice())?.toString() || '0',
        success: receipt.status === 1,
        blockNumber: receipt.blockNumber
      };

    } catch (error) {
      this.logger.error('Failed to pause oracle', error);
      return null;
    }
  }

  /**
   * Unpause oracle updates
   */
  public async unpauseOracle(): Promise<TransactionResult | null> {
    try {
      if (!this.oracleContract) {
        throw new Error('Oracle contract not initialized');
      }

      this.logger.info('Unpausing oracle');

      const tx = await this.oracleContract.unpause();
      const receipt = await tx.wait();

      return {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : 0,
        gasPrice: (await this.getOptimalGasPrice())?.toString() || '0',
        success: receipt.status === 1,
        blockNumber: receipt.blockNumber
      };

    } catch (error) {
      this.logger.error('Failed to unpause oracle', error);
      return null;
    }
  }

  /**
   * Update heartbeat for an asset
   */
  public async updateHeartbeat(assetId: string, heartbeat: number): Promise<TransactionResult | null> {
    try {
      if (!this.oracleContract) {
        throw new Error('Oracle contract not initialized');
      }

      const assetIdBytes32 = ethers.id(assetId);
      
      this.logger.info(`Updating heartbeat for ${assetId}`, { heartbeat });

      const tx = await this.oracleContract.setHeartbeat(assetIdBytes32, heartbeat);
      const receipt = await tx.wait();

      return {
        txHash: tx.hash,
        gasUsed: receipt.gasUsed ? Number(receipt.gasUsed) : 0,
        gasPrice: (await this.getOptimalGasPrice())?.toString() || '0',
        success: receipt.status === 1,
        blockNumber: receipt.blockNumber
      };

    } catch (error) {
      this.logger.error(`Failed to update heartbeat for ${assetId}`, error);
      return null;
    }
  }

  /**
   * Check if oracle has required permissions
   */
  public async checkPermissions(): Promise<{ hasOracleRole: boolean, hasOperatorRole: boolean }> {
    try {
      // This would check roles on the actual contracts
      // For now, assume permissions are correct if contracts are reachable
      const health = await this.getHealth();
      
      return {
        hasOracleRole: health.contractsReachable,
        hasOperatorRole: health.contractsReachable
      };

    } catch (error) {
      this.logger.error('Failed to check permissions', error);
      return {
        hasOracleRole: false,
        hasOperatorRole: false
      };
    }
  }

  /**
   * Get signer address
   */
  public getSignerAddress(): string {
    return this.signer.address || '';
  }

  /**
   * Cleanup resources
   */
  public async cleanup(): Promise<void> {
    try {
      // Cleanup any pending operations
      this.logger.info('Cleaning up oracle service');
    } catch (error) {
      this.logger.error('Error during cleanup', error);
    }
  }
}

export default OracleService;

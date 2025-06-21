// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/ICCYOECore.sol";
import "./interfaces/IVaultManager.sol";
import "./interfaces/IYieldDistributor.sol";
import "./interfaces/ICambiOracle.sol";

/**
 * @title CCYOECore
 * @notice Cross-Collateral Yield Optimization Engine core contract
 * @dev Orchestrates yield distribution across Cambi protocol assets
 */
contract CCYOECore is ICCYOECore, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    struct AssetConfig {
        address vaultAddress;
        uint256 targetYield; // basis points (e.g., 1400 = 14%)
        uint256 supplyCap;
        uint256 currentSupply;
        bool isActive;
        uint256 lastRebalance;
    }

    struct DistributionConfig {
        uint256 underSuppliedAllocation; // 4000 = 40%
        uint256 strategicGrowthAllocation; // 3000 = 30%
        uint256 proportionalAllocation; // 2000 = 20%
        uint256 treasuryAllocation; // 1000 = 10%
        uint256 rebalanceThreshold; // minimum excess yield to trigger rebalance
        uint256 rebalanceFrequency; // minimum time between rebalances
    }

    mapping(bytes32 => AssetConfig) public assetConfigs;
    mapping(address => uint256) public assetYields; // current yield per asset
    mapping(address => uint256) public excessYields; // excess yield available for redistribution
    
    DistributionConfig public distributionConfig;
    IVaultManager public vaultManager;
    IYieldDistributor public yieldDistributor;
    ICambiOracle public oracle;
    
    address public treasury;
    uint256 public totalExcessYield;
    uint256 public lastGlobalRebalance;
    
    // Asset identifiers
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");

    event YieldOptimized(bytes32 indexed asset, uint256 oldYield, uint256 newYield, uint256 timestamp);
    event ExcessYieldDistributed(uint256 totalExcess, uint256 distributed, uint256 timestamp);
    event AssetConfigUpdated(bytes32 indexed asset, uint256 targetYield, uint256 supplyCap);
    event DistributionConfigUpdated(uint256[4] allocations, uint256 threshold, uint256 frequency);
    event EmergencyRebalance(bytes32 indexed asset, uint256 yield, string reason);

    constructor(
        address _vaultManager,
        address _yieldDistributor,
        address _oracle,
        address _treasury,
        address _governance
    ) {
        require(_vaultManager != address(0), "Invalid vault manager");
        require(_yieldDistributor != address(0), "Invalid yield distributor");
        require(_oracle != address(0), "Invalid oracle");
        require(_treasury != address(0), "Invalid treasury");
        require(_governance != address(0), "Invalid governance");

        vaultManager = IVaultManager(_vaultManager);
        yieldDistributor = IYieldDistributor(_yieldDistributor);
        oracle = ICambiOracle(_oracle);
        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, _governance);
        _grantRole(GOVERNANCE_ROLE, _governance);
        _grantRole(OPERATOR_ROLE, _governance);
        _grantRole(EMERGENCY_ROLE, _governance);

        // Initialize default distribution config
        distributionConfig = DistributionConfig({
            underSuppliedAllocation: 4000, // 40%
            strategicGrowthAllocation: 3000, // 30%
            proportionalAllocation: 2000, // 20%
            treasuryAllocation: 1000, // 10%
            rebalanceThreshold: 100, // 1% excess yield threshold
            rebalanceFrequency: 1 days
        });

        // Initialize asset configs with realistic targets from the document
        _initializeAssetConfig(CMBTC, address(0), 500, 20_000_000 * 1e18); // 5% target, $20M cap
        _initializeAssetConfig(CMUSD, address(0), 1400, 50_000_000 * 1e18); // 14% target, $50M cap
        _initializeAssetConfig(CMBRL, address(0), 2000, type(uint256).max); // 20% target, unlimited
    }

    /**
     * @notice Initialize asset configuration
     */
    function _initializeAssetConfig(
        bytes32 assetId,
        address vaultAddress,
        uint256 targetYield,
        uint256 supplyCap
    ) internal {
        assetConfigs[assetId] = AssetConfig({
            vaultAddress: vaultAddress,
            targetYield: targetYield,
            supplyCap: supplyCap,
            currentSupply: 0,
            isActive: false,
            lastRebalance: block.timestamp
        });
    }

    /**
     * @notice Calculate and distribute optimized yields across all assets
     */
    function optimizeYields() external nonReentrant whenNotPaused onlyRole(OPERATOR_ROLE) {
        require(block.timestamp >= lastGlobalRebalance + distributionConfig.rebalanceFrequency, "Too frequent");
        
        _updateAssetYields();
        uint256 totalExcess = _calculateTotalExcessYield();
        
        if (totalExcess >= distributionConfig.rebalanceThreshold) {
            _distributeExcessYield(totalExcess);
            lastGlobalRebalance = block.timestamp;
            
            emit ExcessYieldDistributed(totalExcess, totalExcess, block.timestamp);
        }
    }

    /**
     * @notice Update current yields for all assets from oracle
     */
    function _updateAssetYields() internal {
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        
        for (uint i = 0; i < assets.length; i++) {
            bytes32 assetId = assets[i];
            AssetConfig storage config = assetConfigs[assetId];
            
            if (config.isActive) {
                uint256 currentYield = oracle.getAssetYield(assetId);
                uint256 previousYield = assetYields[config.vaultAddress];
                
                assetYields[config.vaultAddress] = currentYield;
                
                // Calculate excess yield if above target
                if (currentYield > config.targetYield) {
                    excessYields[config.vaultAddress] = currentYield - config.targetYield;
                } else {
                    excessYields[config.vaultAddress] = 0;
                }
                
                if (currentYield != previousYield) {
                    emit YieldOptimized(assetId, previousYield, currentYield, block.timestamp);
                }
            }
        }
    }

    /**
     * @notice Calculate total excess yield available for redistribution
     */
    function _calculateTotalExcessYield() internal view returns (uint256) {
        uint256 total = 0;
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        
        for (uint i = 0; i < assets.length; i++) {
            AssetConfig storage config = assetConfigs[assets[i]];
            if (config.isActive) {
                total += excessYields[config.vaultAddress];
            }
        }
        
        return total;
    }

    /**
     * @notice Distribute excess yield according to allocation strategy
     */
    function _distributeExcessYield(uint256 totalExcess) internal {
        // Calculate allocation amounts
        uint256 underSuppliedAmount = (totalExcess * distributionConfig.underSuppliedAllocation) / 10000;
        uint256 strategicAmount = (totalExcess * distributionConfig.strategicGrowthAllocation) / 10000;
        uint256 proportionalAmount = (totalExcess * distributionConfig.proportionalAllocation) / 10000;
        uint256 treasuryAmount = (totalExcess * distributionConfig.treasuryAllocation) / 10000;

        // Distribute to under-supplied assets (prioritize cmBTC/cmUSD)
        _distributeToUnderSupplied(underSuppliedAmount);
        
        // Strategic growth incentives (boost assets with high utilization)
        _distributeStrategicIncentives(strategicAmount);
        
        // Proportional distribution to all holders
        _distributeProportionally(proportionalAmount);
        
        // Send to treasury
        if (treasuryAmount > 0) {
            yieldDistributor.distributeTo(treasury, treasuryAmount);
        }
    }

    /**
     * @notice Distribute yield to under-supplied assets (cmBTC/cmUSD priority)
     */
    function _distributeToUnderSupplied(uint256 amount) internal {
        AssetConfig storage btcConfig = assetConfigs[CMBTC];
        AssetConfig storage usdConfig = assetConfigs[CMUSD];
        
        uint256 btcUtilization = btcConfig.currentSupply * 10000 / btcConfig.supplyCap;
        uint256 usdUtilization = usdConfig.currentSupply * 10000 / usdConfig.supplyCap;
        
        // Prioritize asset with lower utilization
        if (btcUtilization < usdUtilization && btcConfig.isActive) {
            yieldDistributor.boostAssetYield(btcConfig.vaultAddress, amount / 2);
            if (usdConfig.isActive) {
                yieldDistributor.boostAssetYield(usdConfig.vaultAddress, amount / 2);
            }
        } else if (usdConfig.isActive) {
            yieldDistributor.boostAssetYield(usdConfig.vaultAddress, amount / 2);
            if (btcConfig.isActive) {
                yieldDistributor.boostAssetYield(btcConfig.vaultAddress, amount / 2);
            }
        }
    }

    /**
     * @notice Distribute strategic growth incentives
     */
    function _distributeStrategicIncentives(uint256 amount) internal {
        // Boost assets with utilization > 80%
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        uint256 eligibleAssets = 0;
        
        for (uint i = 0; i < assets.length; i++) {
            AssetConfig storage config = assetConfigs[assets[i]];
            if (config.isActive && config.currentSupply * 10000 / config.supplyCap > 8000) {
                eligibleAssets++;
            }
        }
        
        if (eligibleAssets > 0) {
            uint256 amountPerAsset = amount / eligibleAssets;
            for (uint i = 0; i < assets.length; i++) {
                AssetConfig storage config = assetConfigs[assets[i]];
                if (config.isActive && config.currentSupply * 10000 / config.supplyCap > 8000) {
                    yieldDistributor.boostAssetYield(config.vaultAddress, amountPerAsset);
                }
            }
        }
    }

    /**
     * @notice Distribute proportionally to all active assets
     */
    function _distributeProportionally(uint256 amount) internal {
        uint256 totalActiveSupply = 0;
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        
        // Calculate total supply of active assets
        for (uint i = 0; i < assets.length; i++) {
            AssetConfig storage config = assetConfigs[assets[i]];
            if (config.isActive) {
                totalActiveSupply += config.currentSupply;
            }
        }
        
        if (totalActiveSupply > 0) {
            for (uint i = 0; i < assets.length; i++) {
                AssetConfig storage config = assetConfigs[assets[i]];
                if (config.isActive) {
                    uint256 proportion = (config.currentSupply * amount) / totalActiveSupply;
                    yieldDistributor.boostAssetYield(config.vaultAddress, proportion);
                }
            }
        }
    }

    /**
     * @notice Emergency rebalance for specific asset
     */
    function emergencyRebalance(
        bytes32 assetId,
        uint256 newYield,
        string calldata reason
    ) external onlyRole(EMERGENCY_ROLE) {
        AssetConfig storage config = assetConfigs[assetId];
        require(config.isActive, "Asset not active");
        
        yieldDistributor.setAssetYield(config.vaultAddress, newYield);
        
        emit EmergencyRebalance(assetId, newYield, reason);
    }

    /**
     * @notice Update asset configuration
     */
    function updateAssetConfig(
        bytes32 assetId,
        address vaultAddress,
        uint256 targetYield,
        uint256 supplyCap,
        bool isActive
    ) external onlyRole(GOVERNANCE_ROLE) {
        AssetConfig storage config = assetConfigs[assetId];
        config.vaultAddress = vaultAddress;
        config.targetYield = targetYield;
        config.supplyCap = supplyCap;
        config.isActive = isActive;
        
        emit AssetConfigUpdated(assetId, targetYield, supplyCap);
    }

    /**
     * @notice Update distribution configuration
     */
    function updateDistributionConfig(
        uint256 underSupplied,
        uint256 strategic,
        uint256 proportional,
        uint256 treasuryAlloc,
        uint256 threshold,
        uint256 frequency
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(underSupplied + strategic + proportional + treasuryAlloc == 10000, "Invalid allocation");
        
        distributionConfig.underSuppliedAllocation = underSupplied;
        distributionConfig.strategicGrowthAllocation = strategic;
        distributionConfig.proportionalAllocation = proportional;
        distributionConfig.treasuryAllocation = treasuryAlloc;
        distributionConfig.rebalanceThreshold = threshold;
        distributionConfig.rebalanceFrequency = frequency;
        
        emit DistributionConfigUpdated([underSupplied, strategic, proportional, treasuryAlloc], threshold, frequency);
    }

    /**
     * @notice Update asset supply (called by vault manager)
     */
    function updateAssetSupply(bytes32 assetId, uint256 newSupply) external {
        require(msg.sender == address(vaultManager), "Only vault manager");
        assetConfigs[assetId].currentSupply = newSupply;
    }

    /**
     * @notice Pause protocol
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause protocol
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    /**
     * @notice Get asset configuration
     */
    function getAssetConfig(bytes32 assetId) external view returns (AssetConfig memory) {
        return assetConfigs[assetId];
    }

    /**
     * @notice Get current yields for all assets
     */
    function getAllAssetYields() external view returns (uint256[] memory, address[] memory) {
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        uint256[] memory yields = new uint256[](3);
        address[] memory vaults = new address[](3);
        
        for (uint i = 0; i < assets.length; i++) {
            AssetConfig storage config = assetConfigs[assets[i]];
            yields[i] = assetYields[config.vaultAddress];
            vaults[i] = config.vaultAddress;
        }
        
        return (yields, vaults);
    }
}

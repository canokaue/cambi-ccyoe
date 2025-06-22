// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ICCYOECore.sol";
import "./interfaces/IVaultManager.sol";
import "./interfaces/IYieldDistributor.sol";
import "./interfaces/ICambiOracle.sol";

/**
 * @title CCYOECore
 * @notice Cross-Collateral Yield Optimization Engine core contract
 * @dev Orchestrates yield distribution across Cambi protocol assets with production-grade optimizations
 */
contract CCYOECore is ICCYOECore, AccessControl, Pausable, ReentrancyGuard {
    using Math for uint256;

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    struct AssetConfig {
        address vaultAddress;
        uint256 targetYield;        // Target yield in basis points
        uint256 supplyCap;          // Maximum supply in wei
        uint256 currentSupply;      // Current supply in wei
        bool isActive;              // Asset status
        uint256 lastRebalance;      // Last rebalance timestamp
        uint256 minYield;           // Minimum acceptable yield
        uint256 maxYield;           // Maximum acceptable yield
    }

    struct DistributionConfig {
        uint256 underSuppliedAllocation;    // 4000 = 40%
        uint256 strategicGrowthAllocation;  // 3000 = 30%
        uint256 proportionalAllocation;     // 2000 = 20%
        uint256 treasuryAllocation;         // 1000 = 10%
        uint256 rebalanceThreshold;         // Minimum excess yield to trigger rebalance (basis points)
        uint256 rebalanceFrequency;         // Minimum time between rebalances (seconds)
        uint256 maxRebalanceAmount;         // Maximum amount per rebalance
        uint256 emergencyThreshold;         // Emergency rebalance threshold
    }

    struct YieldMetrics {
        uint256 totalExcessYield;           // Total excess yield available
        uint256 lastDistributionAmount;     // Last distribution amount
        uint256 totalDistributed;           // Total yield distributed to date
        uint256 distributionEfficiency;     // Efficiency ratio (distributed/available)
    }

    // State variables
    mapping(bytes32 => AssetConfig) public assetConfigs;
    mapping(address => uint256) public assetYields;
    mapping(address => uint256) public excessYields;
    mapping(bytes32 => uint256) private _assetSupplyCache;
    
    DistributionConfig public distributionConfig;
    YieldMetrics public yieldMetrics;
    
    IVaultManager public immutable vaultManager;
    IYieldDistributor public immutable yieldDistributor;
    ICambiOracle public immutable oracle;
    
    address public immutable treasury;
    uint256 public lastGlobalRebalance;
    uint256 public rebalanceCount;
    
    // Asset identifiers
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    // Constants for gas optimization
    uint256 private constant BASIS_POINTS = 10000;
    uint256 private constant PRECISION = 1e18;
    uint256 private constant MAX_REBALANCE_FREQUENCY = 1 hours; // Minimum 1 hour between rebalances
    uint256 private constant EMERGENCY_MULTIPLIER = 5; // 5x threshold for emergency rebalance

    event YieldOptimized(
        bytes32 indexed asset,
        uint256 oldYield,
        uint256 newYield,
        uint256 timestamp
    );
    
    event ExcessYieldDistributed(
        uint256 totalExcess,
        uint256 distributed,
        uint256 efficiency,
        uint256 timestamp
    );
    
    event AssetConfigUpdated(
        bytes32 indexed asset,
        uint256 targetYield,
        uint256 supplyCap,
        uint256 minYield,
        uint256 maxYield
    );
    
    event DistributionConfigUpdated(
        uint256[4] allocations,
        uint256 threshold,
        uint256 frequency
    );
    
    event EmergencyRebalance(
        bytes32 indexed asset,
        uint256 yield,
        string reason,
        address indexed executor
    );
    
    event CircuitBreakerTriggered(
        bytes32 indexed asset,
        uint256 yield,
        uint256 threshold,
        uint256 timestamp
    );

    modifier validAsset(bytes32 assetId) {
        require(assetConfigs[assetId].vaultAddress != address(0), "Asset not configured");
        _;
    }

    modifier rateLimited() {
        require(
            block.timestamp >= lastGlobalRebalance + distributionConfig.rebalanceFrequency,
            "Rate limited: too frequent rebalancing"
        );
        _;
    }

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
            underSuppliedAllocation: 4000,      // 40%
            strategicGrowthAllocation: 3000,    // 30%
            proportionalAllocation: 2000,       // 20%
            treasuryAllocation: 1000,           // 10%
            rebalanceThreshold: 100,            // 1% excess yield threshold
            rebalanceFrequency: MAX_REBALANCE_FREQUENCY,
            maxRebalanceAmount: 1000000 * 1e18, // 1M tokens
            emergencyThreshold: 500             // 5% for emergency
        });

        // Initialize asset configs with realistic targets from the protocol document
        _initializeAssetConfig(CMBTC, address(0), 500, 20_000_000 * 1e18, 300, 800);   // 5% target, 3-8% range
        _initializeAssetConfig(CMUSD, address(0), 1400, 50_000_000 * 1e18, 1200, 1800); // 14% target, 12-18% range  
        _initializeAssetConfig(CMBRL, address(0), 2000, type(uint256).max, 1400, 2500);  // 20% target, 14-25% range
    }

    /**
     * @notice Calculate and distribute optimized yields across all assets
     * @dev Main CCYOE function with gas optimizations and safety checks
     */
    function optimizeYields() external nonReentrant whenNotPaused onlyRole(OPERATOR_ROLE) rateLimited {
        // Update yields and calculate excess in single loop for gas efficiency
        (uint256 totalExcess, bool hasExcess) = _updateYieldsAndCalculateExcess();
        
        if (!hasExcess || totalExcess < distributionConfig.rebalanceThreshold) {
            return; // No optimization needed
        }

        // Validate oracle data freshness before proceeding
        require(_validateOracleData(), "Oracle data stale or invalid");
        
        // Execute distribution
        uint256 distributed = _distributeExcessYield(totalExcess);
        
        // Update metrics and state
        _updateMetrics(totalExcess, distributed);
        
        lastGlobalRebalance = block.timestamp;
        rebalanceCount++;
        
        emit ExcessYieldDistributed(
            totalExcess,
            distributed,
            yieldMetrics.distributionEfficiency,
            block.timestamp
        );
    }

    /**
     * @notice Emergency rebalance for specific asset with circuit breaker
     * @param assetId Asset identifier
     * @param newYield New yield value
     * @param reason Reason for emergency rebalance
     */
    function emergencyRebalance(
        bytes32 assetId,
        uint256 newYield,
        string calldata reason
    ) external override onlyRole(EMERGENCY_ROLE) validAsset(assetId) {
        AssetConfig storage config = assetConfigs[assetId];
        
        // Validate emergency conditions
        require(config.isActive, "Asset not active");
        require(newYield >= config.minYield && newYield <= config.maxYield, "Yield out of bounds");
        
        // Check if emergency threshold is met
        uint256 currentYield = assetYields[config.vaultAddress];
        uint256 deviation = newYield > currentYield ? 
            newYield - currentYield : currentYield - newYield;
        
        require(
            deviation >= distributionConfig.emergencyThreshold,
            "Emergency threshold not met"
        );

        // Execute emergency yield update
        yieldDistributor.setAssetYield(config.vaultAddress, newYield);
        assetYields[config.vaultAddress] = newYield;
        config.lastRebalance = block.timestamp;
        
        emit EmergencyRebalance(assetId, newYield, reason, msg.sender);
    }

    /**
     * @notice Update asset configuration with enhanced validation
     * @param assetId Asset identifier
     * @param vaultAddress Vault contract address
     * @param targetYield Target yield in basis points
     * @param supplyCap Maximum supply cap
     * @param minYield Minimum acceptable yield
     * @param maxYield Maximum acceptable yield
     * @param isActive Asset status
     */
    function updateAssetConfig(
        bytes32 assetId,
        address vaultAddress,
        uint256 targetYield,
        uint256 supplyCap,
        uint256 minYield,
        uint256 maxYield,
        bool isActive
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(vaultAddress != address(0) || !isActive, "Invalid vault for active asset");
        require(minYield <= targetYield && targetYield <= maxYield, "Invalid yield bounds");
        require(minYield >= 0 && maxYield <= 50000, "Yield bounds out of range"); // Max 500%
        require(supplyCap > 0, "Invalid supply cap");

        AssetConfig storage config = assetConfigs[assetId];
        config.vaultAddress = vaultAddress;
        config.targetYield = targetYield;
        config.supplyCap = supplyCap;
        config.minYield = minYield;
        config.maxYield = maxYield;
        config.isActive = isActive;
        
        emit AssetConfigUpdated(assetId, targetYield, supplyCap, minYield, maxYield);
    }

    /**
     * @notice Update distribution configuration with validation
     * @param underSupplied Under-supplied allocation (basis points)
     * @param strategic Strategic growth allocation (basis points)
     * @param proportional Proportional allocation (basis points)
     * @param treasuryAlloc Treasury allocation (basis points)
     * @param threshold Rebalance threshold (basis points)
     * @param frequency Minimum rebalance frequency (seconds)
     */
    function updateDistributionConfig(
        uint256 underSupplied,
        uint256 strategic,
        uint256 proportional,
        uint256 treasuryAlloc,
        uint256 threshold,
        uint256 frequency
    ) external override onlyRole(GOVERNANCE_ROLE) {
        require(
            underSupplied + strategic + proportional + treasuryAlloc == BASIS_POINTS,
            "Allocations must sum to 100%"
        );
        require(threshold >= 10 && threshold <= 1000, "Invalid threshold"); // 0.1% to 10%
        require(frequency >= MAX_REBALANCE_FREQUENCY, "Frequency too high");
        require(frequency <= 7 days, "Frequency too low");
        
        distributionConfig.underSuppliedAllocation = underSupplied;
        distributionConfig.strategicGrowthAllocation = strategic;
        distributionConfig.proportionalAllocation = proportional;
        distributionConfig.treasuryAllocation = treasuryAlloc;
        distributionConfig.rebalanceThreshold = threshold;
        distributionConfig.rebalanceFrequency = frequency;
        
        emit DistributionConfigUpdated(
            [underSupplied, strategic, proportional, treasuryAlloc],
            threshold,
            frequency
        );
    }

    /**
     * @notice Update asset supply (called by vault manager)
     * @param assetId Asset identifier
     * @param newSupply New supply amount
     */
    function updateAssetSupply(bytes32 assetId, uint256 newSupply) external override {
        require(msg.sender == address(vaultManager), "Only vault manager");
        
        AssetConfig storage config = assetConfigs[assetId];
        require(config.vaultAddress != address(0), "Asset not configured");
        require(newSupply <= config.supplyCap, "Supply exceeds cap");
        
        config.currentSupply = newSupply;
        _assetSupplyCache[assetId] = newSupply; // Cache for gas optimization
    }

    /**
     * @notice Pause protocol operations
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause protocol operations
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    /**
     * @notice Get asset configuration
     * @param assetId Asset identifier
     * @return AssetConfig struct
     */
    function getAssetConfig(bytes32 assetId) external view override returns (AssetConfig memory) {
        return assetConfigs[assetId];
    }

    /**
     * @notice Get current yields for all assets
     * @return yields Array of current yields
     * @return vaults Array of vault addresses
     */
    function getAllAssetYields() external view override returns (uint256[] memory yields, address[] memory vaults) {
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        yields = new uint256[](3);
        vaults = new address[](3);
        
        for (uint256 i = 0; i < 3;) {
            AssetConfig memory config = assetConfigs[assets[i]];
            yields[i] = assetYields[config.vaultAddress];
            vaults[i] = config.vaultAddress;
            unchecked { ++i; }
        }
    }

    /**
     * @notice Get yield metrics and statistics
     * @return YieldMetrics struct with current metrics
     */
    function getYieldMetrics() external view returns (YieldMetrics memory) {
        return yieldMetrics;
    }

    /**
     * @notice Get distribution efficiency over time
     * @return efficiency Current distribution efficiency percentage
     */
    function getDistributionEfficiency() external view returns (uint256 efficiency) {
        return yieldMetrics.distributionEfficiency;
    }

    // Internal functions with gas optimizations

    function _initializeAssetConfig(
        bytes32 assetId,
        address vaultAddress,
        uint256 targetYield,
        uint256 supplyCap,
        uint256 minYield,
        uint256 maxYield
    ) internal {
        assetConfigs[assetId] = AssetConfig({
            vaultAddress: vaultAddress,
            targetYield: targetYield,
            supplyCap: supplyCap,
            currentSupply: 0,
            isActive: false,
            lastRebalance: block.timestamp,
            minYield: minYield,
            maxYield: maxYield
        });
    }

    function _updateYieldsAndCalculateExcess() internal returns (uint256 totalExcess, bool hasExcess) {
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        
        for (uint256 i = 0; i < 3;) {
            bytes32 assetId = assets[i];
            AssetConfig memory config = assetConfigs[assetId]; // Use memory for gas optimization
            
            if (config.isActive) {
                // Get current yield from oracle with freshness check
                uint256 currentYield = oracle.getAssetYield(assetId);
                require(oracle.isYieldDataValid(assetId), "Stale oracle data");
                
                // Circuit breaker check
                if (_checkCircuitBreaker(assetId, currentYield, config)) {
                    emit CircuitBreakerTriggered(assetId, currentYield, config.maxYield, block.timestamp);
                    continue; // Skip this asset
                }
                
                uint256 previousYield = assetYields[config.vaultAddress];
                assetYields[config.vaultAddress] = currentYield;
                
                // Calculate excess yield with precision
                if (currentYield > config.targetYield) {
                    uint256 excess = currentYield - config.targetYield;
                    excessYields[config.vaultAddress] = excess;
                    totalExcess += excess;
                    hasExcess = true;
                } else {
                    excessYields[config.vaultAddress] = 0;
                }
                
                if (currentYield != previousYield) {
                    emit YieldOptimized(assetId, previousYield, currentYield, block.timestamp);
                }
            }
            unchecked { ++i; }
        }
    }

    function _distributeExcessYield(uint256 totalExcess) internal returns (uint256 distributed) {
        // Calculate allocation amounts with precision
        uint256 underSuppliedAmount = (totalExcess * distributionConfig.underSuppliedAllocation) / BASIS_POINTS;
        uint256 strategicAmount = (totalExcess * distributionConfig.strategicGrowthAllocation) / BASIS_POINTS;
        uint256 proportionalAmount = (totalExcess * distributionConfig.proportionalAllocation) / BASIS_POINTS;
        uint256 treasuryAmount = (totalExcess * distributionConfig.treasuryAllocation) / BASIS_POINTS;

        // Apply maximum rebalance amount limit
        uint256 maxAmount = distributionConfig.maxRebalanceAmount;
        if (totalExcess > maxAmount) {
            uint256 ratio = (maxAmount * BASIS_POINTS) / totalExcess;
            underSuppliedAmount = (underSuppliedAmount * ratio) / BASIS_POINTS;
            strategicAmount = (strategicAmount * ratio) / BASIS_POINTS;
            proportionalAmount = (proportionalAmount * ratio) / BASIS_POINTS;
            treasuryAmount = (treasuryAmount * ratio) / BASIS_POINTS;
        }

        distributed = underSuppliedAmount + strategicAmount + proportionalAmount + treasuryAmount;

        // Execute distributions
        _distributeToUnderSupplied(underSuppliedAmount);
        _distributeStrategicIncentives(strategicAmount);
        _distributeProportionally(proportionalAmount);
        
        // Send to treasury
        if (treasuryAmount > 0) {
            yieldDistributor.distributeTo(treasury, treasuryAmount);
        }
    }

    function _distributeToUnderSupplied(uint256 amount) internal {
        if (amount == 0) return;
        
        AssetConfig memory btcConfig = assetConfigs[CMBTC];
        AssetConfig memory usdConfig = assetConfigs[CMUSD];
        
        if (!btcConfig.isActive && !usdConfig.isActive) return;
        
        // Calculate utilization ratios with safety checks
        uint256 btcUtilization = btcConfig.supplyCap > 0 ? 
            (btcConfig.currentSupply * BASIS_POINTS) / btcConfig.supplyCap : 0;
        uint256 usdUtilization = usdConfig.supplyCap > 0 ? 
            (usdConfig.currentSupply * BASIS_POINTS) / usdConfig.supplyCap : 0;
        
        // Distribute based on lower utilization (more under-supplied gets more)
        if (btcConfig.isActive && usdConfig.isActive) {
            if (btcUtilization <= usdUtilization) {
                // BTC is more under-supplied
                yieldDistributor.boostAssetYield(btcConfig.vaultAddress, (amount * 6) / 10); // 60%
                yieldDistributor.boostAssetYield(usdConfig.vaultAddress, (amount * 4) / 10); // 40%
            } else {
                // USD is more under-supplied
                yieldDistributor.boostAssetYield(usdConfig.vaultAddress, (amount * 6) / 10); // 60%
                yieldDistributor.boostAssetYield(btcConfig.vaultAddress, (amount * 4) / 10); // 40%
            }
        } else if (btcConfig.isActive) {
            yieldDistributor.boostAssetYield(btcConfig.vaultAddress, amount);
        } else if (usdConfig.isActive) {
            yieldDistributor.boostAssetYield(usdConfig.vaultAddress, amount);
        }
    }

    function _distributeStrategicIncentives(uint256 amount) internal {
        if (amount == 0) return;
        
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        uint256 eligibleAssets = 0;
        bool[3] memory isEligible;
        
        // Find assets with utilization > 80%
        for (uint256 i = 0; i < 3;) {
            AssetConfig memory config = assetConfigs[assets[i]];
            if (config.isActive && config.supplyCap > 0) {
                uint256 utilization = (config.currentSupply * BASIS_POINTS) / config.supplyCap;
                if (utilization > 8000) { // 80%
                    isEligible[i] = true;
                    eligibleAssets++;
                }
            }
            unchecked { ++i; }
        }
        
        if (eligibleAssets > 0) {
            uint256 amountPerAsset = amount / eligibleAssets;
            for (uint256 i = 0; i < 3;) {
                if (isEligible[i]) {
                    AssetConfig memory config = assetConfigs[assets[i]];
                    yieldDistributor.boostAssetYield(config.vaultAddress, amountPerAsset);
                }
                unchecked { ++i; }
            }
        }
    }

    function _distributeProportionally(uint256 amount) internal {
        if (amount == 0) return;
        
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        uint256 totalActiveSupply = 0;
        
        // Calculate total supply of active assets
        for (uint256 i = 0; i < 3;) {
            AssetConfig memory config = assetConfigs[assets[i]];
            if (config.isActive) {
                totalActiveSupply += config.currentSupply;
            }
            unchecked { ++i; }
        }
        
        if (totalActiveSupply > 0) {
            for (uint256 i = 0; i < 3;) {
                AssetConfig memory config = assetConfigs[assets[i]];
                if (config.isActive && config.currentSupply > 0) {
                    uint256 proportion = (config.currentSupply * amount) / totalActiveSupply;
                    if (proportion > 0) {
                        yieldDistributor.boostAssetYield(config.vaultAddress, proportion);
                    }
                }
                unchecked { ++i; }
            }
        }
    }

    function _updateMetrics(uint256 totalExcess, uint256 distributed) internal {
        yieldMetrics.totalExcessYield = totalExcess;
        yieldMetrics.lastDistributionAmount = distributed;
        yieldMetrics.totalDistributed += distributed;
        
        // Calculate efficiency with precision
        if (totalExcess > 0) {
            yieldMetrics.distributionEfficiency = (distributed * BASIS_POINTS) / totalExcess;
        }
    }

    function _validateOracleData() internal view returns (bool) {
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        
        for (uint256 i = 0; i < 3;) {
            if (assetConfigs[assets[i]].isActive) {
                if (!oracle.isYieldDataValid(assets[i])) {
                    return false;
                }
            }
            unchecked { ++i; }
        }
        return true;
    }

    function _checkCircuitBreaker(
        bytes32 assetId,
        uint256 currentYield,
        AssetConfig memory config
    ) internal pure returns (bool) {
        // Circuit breaker triggers if yield is outside acceptable bounds
        return currentYield < config.minYield || currentYield > config.maxYield;
    }
}
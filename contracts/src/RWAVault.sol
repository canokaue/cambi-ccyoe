// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IVaultManager.sol";
import "./interfaces/ICambiOracle.sol";

/**
 * @title RWAVault
 * @notice Individual vault for managing Real World Asset collateral and synthetic token minting
 * @dev Implements CDP (Collateralized Debt Position) model similar to MakerDAO
 */
contract RWAVault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    bytes32 public constant VAULT_MANAGER_ROLE = keccak256("VAULT_MANAGER_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // Vault configuration
    struct VaultConfig {
        bytes32 assetId;                    // Asset identifier (cmBTC, cmUSD, cmBRL)
        IERC20 collateralToken;            // Collateral token (WBTC, USDC, etc.)
        IERC20 syntheticToken;             // Synthetic token (cmBTC, cmUSD, cmBRL)
        uint256 collateralizationRatio;    // Minimum collateralization ratio (150% = 15000)
        uint256 liquidationRatio;          // Liquidation threshold (130% = 13000)
        uint256 liquidationPenalty;        // Liquidation penalty (10% = 1000)
        uint256 supplyCap;                 // Maximum supply cap
        uint256 mintFee;                   // Minting fee in basis points (0.1% = 10)
        uint256 redeemFee;                 // Redemption fee in basis points (0.1% = 10)
        bool isActive;                     // Vault status
    }

    // User position
    struct Position {
        uint256 collateralAmount;          // Amount of collateral deposited
        uint256 syntheticAmount;           // Amount of synthetic tokens minted
        uint256 lastInteractionTime;       // Last interaction timestamp
        uint256 accruedYield;              // Accrued yield from CCYOE
        bool exists;                       // Position exists flag
    }

    // Lock period for yield optimization
    struct LockPeriod {
        uint256 duration;                  // Lock duration in seconds
        uint256 yieldMultiplier;           // Yield multiplier (1.2x = 12000)
        uint256 unlockTime;                // Unlock timestamp
    }

    VaultConfig public config;
    IVaultManager public vaultManager;
    ICambiOracle public oracle;

    mapping(address => Position) public positions;
    mapping(address => LockPeriod) public lockPeriods;
    
    uint256 public totalCollateral;
    uint256 public totalSynthetic;
    uint256 public totalYieldDistributed;
    uint256 public lastYieldDistribution;
    
    // Yield rebasing
    uint256 public rebaseIndex = 1e18;     // Starting at 1.0
    uint256 public lastRebaseTime;
    
    // Constants
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    event PositionOpened(address indexed user, uint256 collateralAmount, uint256 syntheticAmount);
    event PositionClosed(address indexed user, uint256 collateralReturned, uint256 syntheticBurned);
    event CollateralAdded(address indexed user, uint256 amount);
    event SyntheticMinted(address indexed user, uint256 amount);
    event SyntheticRedeemed(address indexed user, uint256 amount, uint256 collateralReturned);
    event PositionLiquidated(address indexed user, address indexed liquidator, uint256 collateralSeized, uint256 penalty);
    event YieldDistributed(uint256 totalYield, uint256 newRebaseIndex);
    event LockPeriodSet(address indexed user, uint256 duration, uint256 unlockTime);

    modifier onlyVaultManager() {
        require(hasRole(VAULT_MANAGER_ROLE, msg.sender), "Only vault manager");
        _;
    }

    modifier positionExists(address user) {
        require(positions[user].exists, "Position does not exist");
        _;
    }

    modifier onlyActiveVault() {
        require(config.isActive, "Vault is not active");
        _;
    }

    constructor(
        VaultConfig memory _config,
        address _vaultManager,
        address _oracle,
        address _admin
    ) {
        require(_config.collateralToken != IERC20(address(0)), "Invalid collateral token");
        require(_config.syntheticToken != IERC20(address(0)), "Invalid synthetic token");
        require(_config.collateralizationRatio >= 11000, "CR too low"); // Min 110%
        require(_config.liquidationRatio <= _config.collateralizationRatio, "Invalid liquidation ratio");
        
        config = _config;
        vaultManager = IVaultManager(_vaultManager);
        oracle = ICambiOracle(_oracle);
        lastRebaseTime = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(VAULT_MANAGER_ROLE, _vaultManager);
        _grantRole(EMERGENCY_ROLE, _admin);
    }

    /**
     * @notice Open a new position by depositing collateral and minting synthetics
     * @param collateralAmount Amount of collateral to deposit
     * @param syntheticAmount Amount of synthetic tokens to mint
     * @param lockDuration Lock duration for yield optimization (0 for no lock)
     */
    function openPosition(
        uint256 collateralAmount,
        uint256 syntheticAmount,
        uint256 lockDuration
    ) external nonReentrant whenNotPaused onlyActiveVault {
        require(!positions[msg.sender].exists, "Position already exists");
        require(collateralAmount > 0, "Invalid collateral amount");
        require(syntheticAmount > 0, "Invalid synthetic amount");
        require(totalSynthetic + syntheticAmount <= config.supplyCap, "Supply cap exceeded");

        // Check collateralization ratio
        uint256 collateralValue = _getCollateralValue(collateralAmount);
        uint256 syntheticValue = _getSyntheticValue(syntheticAmount);
        uint256 collateralizationRatio = (collateralValue * BASIS_POINTS) / syntheticValue;
        
        require(collateralizationRatio >= config.collateralizationRatio, "Insufficient collateralization");

        // Apply minting fee
        uint256 mintFee = (syntheticAmount * config.mintFee) / BASIS_POINTS;
        uint256 syntheticToMint = syntheticAmount - mintFee;

        // Transfer collateral
        config.collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);

        // Create position
        positions[msg.sender] = Position({
            collateralAmount: collateralAmount,
            syntheticAmount: syntheticToMint,
            lastInteractionTime: block.timestamp,
            accruedYield: 0,
            exists: true
        });

        // Set lock period if specified
        if (lockDuration > 0) {
            _setLockPeriod(msg.sender, lockDuration);
        }

        // Update totals
        totalCollateral += collateralAmount;
        totalSynthetic += syntheticToMint;

        // Mint synthetic tokens
        require(config.syntheticToken.transfer(msg.sender, syntheticToMint), "Mint failed");

        // Update vault manager
        vaultManager.updateVaultSupply(config.assetId, totalSynthetic);

        emit PositionOpened(msg.sender, collateralAmount, syntheticToMint);
    }

    /**
     * @notice Close position by burning synthetics and withdrawing collateral
     * @param syntheticAmount Amount of synthetic tokens to burn
     */
    function closePosition(uint256 syntheticAmount) external nonReentrant positionExists(msg.sender) {
        Position storage position = positions[msg.sender];
        require(syntheticAmount <= position.syntheticAmount, "Insufficient synthetic balance");
        require(!_isLocked(msg.sender), "Position is locked");

        // Calculate collateral to return proportionally
        uint256 collateralToReturn = (position.collateralAmount * syntheticAmount) / position.syntheticAmount;
        
        // Apply redemption fee
        uint256 redeemFee = (collateralToReturn * config.redeemFee) / BASIS_POINTS;
        collateralToReturn -= redeemFee;

        // Distribute accrued yield
        uint256 yieldToDistribute = _calculateAccruedYield(msg.sender);
        
        // Update position
        position.collateralAmount -= (position.collateralAmount * syntheticAmount) / position.syntheticAmount;
        position.syntheticAmount -= syntheticAmount;
        position.lastInteractionTime = block.timestamp;
        position.accruedYield = 0;

        // Update totals
        totalCollateral -= collateralToReturn + redeemFee;
        totalSynthetic -= syntheticAmount;

        // Burn synthetic tokens
        config.syntheticToken.safeTransferFrom(msg.sender, address(this), syntheticAmount);

        // Return collateral + yield
        config.collateralToken.safeTransfer(msg.sender, collateralToReturn + yieldToDistribute);

        // If position fully closed, delete it
        if (position.syntheticAmount == 0) {
            delete positions[msg.sender];
            delete lockPeriods[msg.sender];
            emit PositionClosed(msg.sender, collateralToReturn, syntheticAmount);
        }

        // Update vault manager
        vaultManager.updateVaultSupply(config.assetId, totalSynthetic);

        emit SyntheticRedeemed(msg.sender, syntheticAmount, collateralToReturn);
    }

    /**
     * @notice Add collateral to existing position
     * @param amount Amount of collateral to add
     */
    function addCollateral(uint256 amount) external nonReentrant positionExists(msg.sender) {
        require(amount > 0, "Invalid amount");

        config.collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        
        positions[msg.sender].collateralAmount += amount;
        positions[msg.sender].lastInteractionTime = block.timestamp;
        totalCollateral += amount;

        emit CollateralAdded(msg.sender, amount);
    }

    /**
     * @notice Mint additional synthetic tokens against existing collateral
     * @param amount Amount of synthetic tokens to mint
     */
    function mintSynthetic(uint256 amount) external nonReentrant positionExists(msg.sender) whenNotPaused {
        require(amount > 0, "Invalid amount");
        require(totalSynthetic + amount <= config.supplyCap, "Supply cap exceeded");

        Position storage position = positions[msg.sender];
        
        // Check new collateralization ratio
        uint256 collateralValue = _getCollateralValue(position.collateralAmount);
        uint256 newSyntheticAmount = position.syntheticAmount + amount;
        uint256 newSyntheticValue = _getSyntheticValue(newSyntheticAmount);
        uint256 newCollateralizationRatio = (collateralValue * BASIS_POINTS) / newSyntheticValue;
        
        require(newCollateralizationRatio >= config.collateralizationRatio, "Insufficient collateralization");

        // Apply minting fee
        uint256 mintFee = (amount * config.mintFee) / BASIS_POINTS;
        uint256 syntheticToMint = amount - mintFee;

        // Update position
        position.syntheticAmount += syntheticToMint;
        position.lastInteractionTime = block.timestamp;
        totalSynthetic += syntheticToMint;

        // Mint synthetic tokens
        require(config.syntheticToken.transfer(msg.sender, syntheticToMint), "Mint failed");

        // Update vault manager
        vaultManager.updateVaultSupply(config.assetId, totalSynthetic);

        emit SyntheticMinted(msg.sender, syntheticToMint);
    }

    /**
     * @notice Liquidate an undercollateralized position
     * @param user Address of the position to liquidate
     */
    function liquidatePosition(address user) external nonReentrant positionExists(user) {
        require(hasRole(LIQUIDATOR_ROLE, msg.sender), "Not authorized liquidator");
        require(_isLiquidatable(user), "Position not liquidatable");

        Position storage position = positions[user];
        
        // Calculate liquidation amounts
        uint256 liquidationPenalty = (position.collateralAmount * config.liquidationPenalty) / BASIS_POINTS;
        
        // Liquidator receives penalty + slight bonus
        uint256 liquidatorReward = liquidationPenalty + (liquidationPenalty / 10); // 10% bonus
        uint256 collateralToReturn = position.collateralAmount - liquidationPenalty - liquidatorReward;

        // Update totals
        totalCollateral -= position.collateralAmount;
        totalSynthetic -= position.syntheticAmount;

        // Transfer rewards
        config.collateralToken.safeTransfer(msg.sender, liquidatorReward);
        if (collateralToReturn > 0) {
            config.collateralToken.safeTransfer(user, collateralToReturn);
        }

        emit PositionLiquidated(user, msg.sender, position.collateralAmount, liquidationPenalty);

        // Delete position
        delete positions[user];
        delete lockPeriods[user];

        // Update vault manager
        vaultManager.updateVaultSupply(config.assetId, totalSynthetic);
    }

    /**
     * @notice Distribute yield from CCYOE to position holders
     * @param totalYieldAmount Total yield to distribute
     */
    function distributeYield(uint256 totalYieldAmount) external onlyVaultManager {
        require(totalYieldAmount > 0, "Invalid yield amount");
        require(totalSynthetic > 0, "No synthetic tokens to distribute to");

        // Update rebase index
        uint256 yieldPerToken = (totalYieldAmount * PRECISION) / totalSynthetic;
        rebaseIndex += yieldPerToken;
        
        totalYieldDistributed += totalYieldAmount;
        lastYieldDistribution = block.timestamp;
        lastRebaseTime = block.timestamp;

        emit YieldDistributed(totalYieldAmount, rebaseIndex);
    }

    /**
     * @notice Set lock period for yield optimization
     * @param duration Lock duration in seconds
     */
    function setLockPeriod(uint256 duration) external positionExists(msg.sender) {
        require(duration >= 7 days, "Minimum 7 days lock");
        require(duration <= 365 days, "Maximum 365 days lock");
        require(!_isLocked(msg.sender), "Already locked");

        _setLockPeriod(msg.sender, duration);
    }

    /**
     * @notice Emergency pause the vault
     */
    function emergencyPause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Emergency unpause the vault
     */
    function emergencyUnpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    // View functions

    /**
     * @notice Get position information
     * @param user User address
     * @return Position details including accrued yield
     */
    function getPosition(address user) external view returns (
        uint256 collateralAmount,
        uint256 syntheticAmount,
        uint256 collateralizationRatio,
        uint256 accruedYield,
        bool isLocked,
        uint256 unlockTime
    ) {
        Position memory position = positions[user];
        require(position.exists, "Position does not exist");

        uint256 collateralValue = _getCollateralValue(position.collateralAmount);
        uint256 syntheticValue = _getSyntheticValue(position.syntheticAmount);
        uint256 ratio = syntheticValue > 0 ? (collateralValue * BASIS_POINTS) / syntheticValue : 0;

        return (
            position.collateralAmount,
            position.syntheticAmount,
            ratio,
            _calculateAccruedYield(user),
            _isLocked(user),
            lockPeriods[user].unlockTime
        );
    }

    /**
     * @notice Check if position is liquidatable
     * @param user User address
     * @return True if position can be liquidated
     */
    function isLiquidatable(address user) external view returns (bool) {
        return _isLiquidatable(user);
    }

    /**
     * @notice Get vault statistics
     */
    function getVaultStats() external view returns (
        uint256 _totalCollateral,
        uint256 _totalSynthetic,
        uint256 _totalYieldDistributed,
        uint256 _rebaseIndex,
        uint256 utilizationRatio
    ) {
        uint256 utilization = config.supplyCap > 0 ? (totalSynthetic * BASIS_POINTS) / config.supplyCap : 0;
        
        return (
            totalCollateral,
            totalSynthetic,
            totalYieldDistributed,
            rebaseIndex,
            utilization
        );
    }

    // Internal functions

    function _setLockPeriod(address user, uint256 duration) internal {
        uint256 yieldMultiplier = _calculateYieldMultiplier(duration);
        
        lockPeriods[user] = LockPeriod({
            duration: duration,
            yieldMultiplier: yieldMultiplier,
            unlockTime: block.timestamp + duration
        });

        emit LockPeriodSet(user, duration, block.timestamp + duration);
    }

    function _calculateYieldMultiplier(uint256 duration) internal pure returns (uint256) {
        // Yield multiplier increases with lock duration
        // 3 months: 1.1x, 6 months: 1.2x, 12 months: 1.5x
        if (duration >= 365 days) return 15000; // 1.5x
        if (duration >= 180 days) return 12000; // 1.2x
        if (duration >= 90 days) return 11000;  // 1.1x
        return 10000; // 1.0x (no lock)
    }

    function _isLocked(address user) internal view returns (bool) {
        return lockPeriods[user].unlockTime > block.timestamp;
    }

    function _isLiquidatable(address user) internal view returns (bool) {
        if (!positions[user].exists) return false;
        
        Position memory position = positions[user];
        uint256 collateralValue = _getCollateralValue(position.collateralAmount);
        uint256 syntheticValue = _getSyntheticValue(position.syntheticAmount);
        
        if (syntheticValue == 0) return false;
        
        uint256 collateralizationRatio = (collateralValue * BASIS_POINTS) / syntheticValue;
        return collateralizationRatio < config.liquidationRatio;
    }

    function _calculateAccruedYield(address user) internal view returns (uint256) {
        Position memory position = positions[user];
        if (!position.exists || position.syntheticAmount == 0) return 0;

        // Calculate yield based on rebase index and lock multiplier
        uint256 baseYield = (position.syntheticAmount * (rebaseIndex - PRECISION)) / PRECISION;
        
        if (_isLocked(user)) {
            uint256 multiplier = lockPeriods[user].yieldMultiplier;
            baseYield = (baseYield * multiplier) / BASIS_POINTS;
        }

        return baseYield + position.accruedYield;
    }

    function _getCollateralValue(uint256 amount) internal view returns (uint256) {
        // In production, this would get price from oracle
        // For now, assume 1:1 for simplicity
        return amount;
    }

    function _getSyntheticValue(uint256 amount) internal view returns (uint256) {
        // Get current yield-adjusted value from oracle
        uint256 currentYield = oracle.getAssetYield(config.assetId);
        
        // Apply yield to determine value (simplified)
        return amount; // In production, would factor in accumulated yield
    }
}
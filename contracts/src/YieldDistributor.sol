// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/IYieldDistributor.sol";

/**
 * @title YieldDistributor
 * @notice Handles yield distribution and boosting for CCYOE with precision and safety
 * @dev Production-grade yield distribution with rebasing mechanics and fee management
 */
contract YieldDistributor is IYieldDistributor, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant VAULT_ROLE = keccak256("VAULT_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    struct VaultState {
        uint256 baseYield;              // Base yield in basis points
        uint256 yieldBoost;             // Current yield boost
        uint256 totalDistributed;       // Total yield distributed to this vault
        uint256 lastDistribution;       // Timestamp of last distribution
        uint256 rebaseIndex;            // Rebase index for yield tracking
        bool isActive;                  // Vault status
        address yieldToken;             // Token used for yield distribution
    }

    struct DistributionMetrics {
        uint256 totalYieldDistributed;  // Total yield distributed across all vaults
        uint256 totalBoostsApplied;     // Total number of boosts applied
        uint256 averageDistribution;    // Average distribution amount
        uint256 lastGlobalDistribution; // Last global distribution timestamp
        uint256 distributionCount;      // Number of distributions executed
    }

    struct DistributionLimits {
        uint256 maxSingleDistribution;  // Maximum single distribution amount
        uint256 maxDailyDistribution;   // Maximum daily distribution total
        uint256 minDistributionAmount;  // Minimum distribution amount
        uint256 distributionCooldown;   // Cooldown between distributions
    }

    // State variables
    mapping(address => VaultState) public vaultStates;
    mapping(address => uint256) public dailyDistributed;
    mapping(address => uint256) public lastDistributionDay;
    
    DistributionMetrics public distributionMetrics;
    DistributionLimits public distributionLimits;
    
    address[] public registeredVaults;
    mapping(address => bool) public isRegisteredVault;
    
    // Constants
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_YIELD_BOOST = 5000; // 50% maximum boost
    uint256 public constant SECONDS_PER_DAY = 86400;

    event YieldDistributed(
        address indexed vault,
        uint256 amount,
        uint256 newRebaseIndex,
        uint256 timestamp
    );
    
    event AssetYieldBoosted(
        address indexed vault,
        uint256 boostAmount,
        uint256 newTotalYield,
        uint256 timestamp
    );
    
    event VaultRegistered(
        address indexed vault,
        address indexed yieldToken,
        uint256 timestamp
    );
    
    event VaultDeactivated(
        address indexed vault,
        uint256 timestamp
    );
    
    event DistributionLimitsUpdated(
        uint256 maxSingle,
        uint256 maxDaily,
        uint256 minAmount,
        uint256 cooldown
    );
    
    event EmergencyWithdrawal(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );

    modifier onlyDistributor() {
        require(hasRole(DISTRIBUTOR_ROLE, msg.sender), "Not authorized distributor");
        _;
    }

    modifier onlyRegisteredVault(address vault) {
        require(isRegisteredVault[vault], "Vault not registered");
        _;
    }

    modifier withinLimits(address vault, uint256 amount) {
        require(amount >= distributionLimits.minDistributionAmount, "Amount below minimum");
        require(amount <= distributionLimits.maxSingleDistribution, "Amount exceeds single limit");
        
        // Check daily limits
        uint256 currentDay = block.timestamp / SECONDS_PER_DAY;
        if (lastDistributionDay[vault] != currentDay) {
            dailyDistributed[vault] = 0;
            lastDistributionDay[vault] = currentDay;
        }
        
        require(
            dailyDistributed[vault] + amount <= distributionLimits.maxDailyDistribution,
            "Exceeds daily limit"
        );
        _;
    }

    modifier respectsCooldown(address vault) {
        require(
            block.timestamp >= vaultStates[vault].lastDistribution + distributionLimits.distributionCooldown,
            "Distribution cooldown active"
        );
        _;
    }

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DISTRIBUTOR_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, admin);
        
        // Initialize default limits
        distributionLimits = DistributionLimits({
            maxSingleDistribution: 1000000 * 1e18, // 1M tokens
            maxDailyDistribution: 5000000 * 1e18,  // 5M tokens daily
            minDistributionAmount: 1000 * 1e18,    // 1K tokens minimum
            distributionCooldown: 1 hours           // 1 hour cooldown
        });
    }

    /**
     * @notice Register a new vault for yield distribution
     * @param vault Vault address
     * @param yieldToken Token used for yield distribution
     * @param baseYield Initial base yield in basis points
     */
    function registerVault(
        address vault,
        address yieldToken,
        uint256 baseYield
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(vault != address(0), "Invalid vault address");
        require(yieldToken != address(0), "Invalid yield token");
        require(!isRegisteredVault[vault], "Vault already registered");
        require(baseYield <= 50000, "Base yield too high"); // Max 500%

        vaultStates[vault] = VaultState({
            baseYield: baseYield,
            yieldBoost: 0,
            totalDistributed: 0,
            lastDistribution: block.timestamp,
            rebaseIndex: PRECISION, // Start at 1.0
            isActive: true,
            yieldToken: yieldToken
        });

        registeredVaults.push(vault);
        isRegisteredVault[vault] = true;

        // Grant vault role for self-management
        _grantRole(VAULT_ROLE, vault);

        emit VaultRegistered(vault, yieldToken, block.timestamp);
    }

    /**
     * @notice Distribute yield to a specific recipient
     * @param recipient Recipient address
     * @param amount Amount to distribute
     */
    function distributeTo(
        address recipient,
        uint256 amount
    ) external override nonReentrant onlyDistributor whenNotPaused withinLimits(recipient, amount) {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");

        // Update daily distribution tracking
        uint256 currentDay = block.timestamp / SECONDS_PER_DAY;
        if (lastDistributionDay[recipient] != currentDay) {
            dailyDistributed[recipient] = 0;
            lastDistributionDay[recipient] = currentDay;
        }
        
        dailyDistributed[recipient] += amount;

        // Update global metrics
        _updateGlobalMetrics(amount);

        emit YieldDistributed(recipient, amount, 0, block.timestamp);
    }

    /**
     * @notice Boost yield for a specific vault
     * @param vault Vault address
     * @param boostAmount Amount to boost in basis points
     */
    function boostAssetYield(
        address vault,
        uint256 boostAmount
    ) external override nonReentrant onlyDistributor onlyRegisteredVault(vault) whenNotPaused respectsCooldown(vault) {
        require(boostAmount > 0, "Invalid boost amount");
        require(boostAmount <= MAX_YIELD_BOOST, "Boost amount too high");

        VaultState storage state = vaultStates[vault];
        require(state.isActive, "Vault not active");

        // Apply yield boost with overflow protection
        uint256 newBoost = state.yieldBoost + boostAmount;
        require(newBoost <= MAX_YIELD_BOOST, "Total boost exceeds maximum");

        state.yieldBoost = newBoost;
        state.lastDistribution = block.timestamp;

        // Update rebase index
        uint256 boostMultiplier = PRECISION + ((boostAmount * PRECISION) / BASIS_POINTS);
        state.rebaseIndex = (state.rebaseIndex * boostMultiplier) / PRECISION;

        // Update metrics
        distributionMetrics.totalBoostsApplied++;
        _updateGlobalMetrics(boostAmount);

        uint256 newTotalYield = state.baseYield + state.yieldBoost;

        emit AssetYieldBoosted(vault, boostAmount, newTotalYield, block.timestamp);
    }

    /**
     * @notice Set absolute yield for a vault (emergency use)
     * @param vault Vault address
     * @param newYield New yield in basis points
     */
    function setAssetYield(
        address vault,
        uint256 newYield
    ) external override nonReentrant onlyDistributor onlyRegisteredVault(vault) {
        require(newYield <= 50000, "Yield too high"); // Max 500%

        VaultState storage state = vaultStates[vault];
        require(state.isActive, "Vault not active");

        // Reset boost and set new base yield
        state.baseYield = newYield;
        state.yieldBoost = 0;
        state.lastDistribution = block.timestamp;

        // Reset rebase index
        state.rebaseIndex = PRECISION;

        emit YieldDistributed(vault, newYield, state.rebaseIndex, block.timestamp);
    }

    /**
     * @notice Get current yield for a vault
     * @param vault Vault address
     * @return Current total yield (base + boost)
     */
    function getVaultYield(address vault) external view override returns (uint256) {
        VaultState memory state = vaultStates[vault];
        return state.baseYield + state.yieldBoost;
    }

    /**
     * @notice Get vault boost amount
     * @param vault Vault address
     * @return Current boost amount
     */
    function getVaultBoost(address vault) external view returns (uint256) {
        return vaultStates[vault].yieldBoost;
    }

    /**
     * @notice Get vault state information
     * @param vault Vault address
     * @return VaultState struct
     */
    function getVaultState(address vault) external view returns (VaultState memory) {
        return vaultStates[vault];
    }

    /**
     * @notice Get distribution metrics
     * @return DistributionMetrics struct
     */
    function getDistributionMetrics() external view returns (DistributionMetrics memory) {
        return distributionMetrics;
    }

    /**
     * @notice Get all registered vaults
     * @return Array of vault addresses
     */
    function getRegisteredVaults() external view returns (address[] memory) {
        return registeredVaults;
    }

    /**
     * @notice Calculate accrued yield for a vault since last distribution
     * @param vault Vault address
     * @param principal Principal amount
     * @return Accrued yield amount
     */
    function calculateAccruedYield(
        address vault,
        uint256 principal
    ) external view onlyRegisteredVault(vault) returns (uint256) {
        VaultState memory state = vaultStates[vault];
        
        if (!state.isActive || principal == 0) {
            return 0;
        }

        // Calculate time-based yield accrual
        uint256 timeElapsed = block.timestamp - state.lastDistribution;
        uint256 annualYield = state.baseYield + state.yieldBoost;
        
        // Convert to per-second yield rate
        uint256 secondlyRate = (annualYield * PRECISION) / (365 days * BASIS_POINTS);
        
        // Calculate accrued yield
        uint256 accruedYield = (principal * secondlyRate * timeElapsed) / PRECISION;
        
        return accruedYield;
    }

    /**
     * @notice Update distribution limits (admin only)
     * @param maxSingle Maximum single distribution
     * @param maxDaily Maximum daily distribution
     * @param minAmount Minimum distribution amount
     * @param cooldown Distribution cooldown period
     */
    function updateDistributionLimits(
        uint256 maxSingle,
        uint256 maxDaily,
        uint256 minAmount,
        uint256 cooldown
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(maxSingle > 0 && maxSingle <= maxDaily, "Invalid single limit");
        require(maxDaily > 0, "Invalid daily limit");
        require(minAmount > 0 && minAmount <= maxSingle, "Invalid minimum amount");
        require(cooldown >= 5 minutes && cooldown <= 24 hours, "Invalid cooldown");

        distributionLimits.maxSingleDistribution = maxSingle;
        distributionLimits.maxDailyDistribution = maxDaily;
        distributionLimits.minDistributionAmount = minAmount;
        distributionLimits.distributionCooldown = cooldown;

        emit DistributionLimitsUpdated(maxSingle, maxDaily, minAmount, cooldown);
    }

    /**
     * @notice Deactivate a vault
     * @param vault Vault address
     */
    function deactivateVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) onlyRegisteredVault(vault) {
        vaultStates[vault].isActive = false;
        emit VaultDeactivated(vault, block.timestamp);
    }

    /**
     * @notice Reactivate a vault
     * @param vault Vault address
     */
    function reactivateVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) onlyRegisteredVault(vault) {
        vaultStates[vault].isActive = true;
        vaultStates[vault].lastDistribution = block.timestamp;
    }

    /**
     * @notice Reset vault boost (emergency function)
     * @param vault Vault address
     */
    function resetVaultBoost(address vault) external onlyRole(EMERGENCY_ROLE) onlyRegisteredVault(vault) {
        vaultStates[vault].yieldBoost = 0;
        vaultStates[vault].rebaseIndex = PRECISION;
        vaultStates[vault].lastDistribution = block.timestamp;
    }

    /**
     * @notice Emergency token withdrawal
     * @param token Token address
     * @param recipient Recipient address
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(
        address token,
        address recipient,
        uint256 amount
    ) external onlyRole(EMERGENCY_ROLE) {
        require(token != address(0), "Invalid token");
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");

        IERC20(token).safeTransfer(recipient, amount);
        
        emit EmergencyWithdrawal(token, recipient, amount);
    }

    /**
     * @notice Pause contract operations
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause contract operations
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

    // Internal functions

    function _updateGlobalMetrics(uint256 amount) internal {
        distributionMetrics.totalYieldDistributed += amount;
        distributionMetrics.distributionCount++;
        distributionMetrics.lastGlobalDistribution = block.timestamp;
        
        // Update average distribution
        if (distributionMetrics.distributionCount > 0) {
            distributionMetrics.averageDistribution = 
                distributionMetrics.totalYieldDistributed / distributionMetrics.distributionCount;
        }
    }

    /**
     * @notice Get distribution limits
     * @return DistributionLimits struct
     */
    function getDistributionLimits() external view returns (DistributionLimits memory) {
        return distributionLimits;
    }

    /**
     * @notice Check if vault can receive distribution
     * @param vault Vault address
     * @param amount Distribution amount
     * @return canDistribute Whether distribution is allowed
     * @return reason Reason if distribution is not allowed
     */
    function canDistribute(
        address vault,
        uint256 amount
    ) external view returns (bool canDistribute, string memory reason) {
        if (!isRegisteredVault[vault]) {
            return (false, "Vault not registered");
        }
        
        if (!vaultStates[vault].isActive) {
            return (false, "Vault not active");
        }
        
        if (amount < distributionLimits.minDistributionAmount) {
            return (false, "Amount below minimum");
        }
        
        if (amount > distributionLimits.maxSingleDistribution) {
            return (false, "Amount exceeds single limit");
        }
        
        // Check cooldown
        if (block.timestamp < vaultStates[vault].lastDistribution + distributionLimits.distributionCooldown) {
            return (false, "Distribution cooldown active");
        }
        
        // Check daily limits
        uint256 currentDay = block.timestamp / SECONDS_PER_DAY;
        uint256 todayDistributed = lastDistributionDay[vault] == currentDay ? dailyDistributed[vault] : 0;
        
        if (todayDistributed + amount > distributionLimits.maxDailyDistribution) {
            return (false, "Exceeds daily limit");
        }
        
        return (true, "");
    }

    /**
     * @notice Batch update vault yields
     * @param vaults Array of vault addresses
     * @param yields Array of new yields
     */
    function batchUpdateVaultYields(
        address[] calldata vaults,
        uint256[] calldata yields
    ) external onlyRole(DISTRIBUTOR_ROLE) {
        require(vaults.length == yields.length, "Array length mismatch");
        require(vaults.length <= 50, "Too many vaults"); // Gas limit protection
        
        for (uint256 i = 0; i < vaults.length;) {
            if (isRegisteredVault[vaults[i]] && vaultStates[vaults[i]].isActive) {
                vaultStates[vaults[i]].baseYield = yields[i];
                vaultStates[vaults[i]].lastDistribution = block.timestamp;
            }
            unchecked { ++i; }
        }
    }
}
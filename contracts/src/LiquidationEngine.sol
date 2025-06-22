// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ICambiOracle.sol";
import "./interfaces/IVaultManager.sol";
import "./RWAVault.sol";

/**
 * @title LiquidationEngine
 * @notice Handles automated liquidations across all vaults in the CCYOE system
 * @dev Implements efficient liquidation execution with Uniswap V4 integration
 */
contract LiquidationEngine is AccessControl, ReentrancyGuard, Pausable {
    using Math for uint256;

    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    struct LiquidationParams {
        uint256 maxLiquidationRatio;      // Maximum LTV for liquidation (90% = 9000)
        uint256 liquidationIncentive;     // Liquidator incentive (5% = 500)
        uint256 maxLiquidationAmount;     // Max amount per liquidation
        uint256 liquidationDelay;         // Delay before liquidation (grace period)
        bool autoLiquidationEnabled;      // Enable automatic liquidations
    }

    struct PendingLiquidation {
        address vault;
        address position;
        uint256 scheduledTime;
        uint256 collateralizationRatio;
        bool executed;
    }

    struct LiquidationStats {
        uint256 totalLiquidations;
        uint256 totalCollateralLiquidated;
        uint256 totalPenaltiesCollected;
        uint256 avgLiquidationTime;
    }

    IVaultManager public immutable vaultManager;
    ICambiOracle public immutable oracle;
    
    LiquidationParams public params;
    LiquidationStats public stats;
    
    mapping(bytes32 => PendingLiquidation) public pendingLiquidations;
    mapping(address => bool) public authorizedLiquidators;
    mapping(address => uint256) public liquidatorRewards;
    
    bytes32[] public pendingLiquidationIds;
    uint256 public nextLiquidationId;

    // Constants
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_LIQUIDATION_INCENTIVE = 1000; // 10%
    uint256 public constant MIN_LIQUIDATION_DELAY = 1 hours;
    uint256 public constant MAX_LIQUIDATION_DELAY = 24 hours;

    event LiquidationScheduled(
        bytes32 indexed liquidationId,
        address indexed vault,
        address indexed position,
        uint256 scheduledTime,
        uint256 collateralizationRatio
    );
    
    event LiquidationExecuted(
        bytes32 indexed liquidationId,
        address indexed vault,
        address indexed position,
        address liquidator,
        uint256 collateralSeized,
        uint256 penalty,
        uint256 liquidatorReward
    );
    
    event LiquidationCancelled(
        bytes32 indexed liquidationId,
        address indexed vault,
        address indexed position,
        string reason
    );
    
    event EmergencyLiquidation(
        address indexed vault,
        address indexed position,
        address indexed liquidator,
        uint256 collateralSeized
    );

    modifier onlyAuthorizedLiquidator() {
        require(
            hasRole(LIQUIDATOR_ROLE, msg.sender) || authorizedLiquidators[msg.sender],
            "Not authorized liquidator"
        );
        _;
    }

    constructor(
        address _vaultManager,
        address _oracle,
        address _admin,
        LiquidationParams memory _params
    ) {
        require(_vaultManager != address(0), "Invalid vault manager");
        require(_oracle != address(0), "Invalid oracle");
        require(_params.liquidationDelay >= MIN_LIQUIDATION_DELAY, "Delay too short");
        require(_params.liquidationDelay <= MAX_LIQUIDATION_DELAY, "Delay too long");
        require(_params.liquidationIncentive <= MAX_LIQUIDATION_INCENTIVE, "Incentive too high");

        vaultManager = IVaultManager(_vaultManager);
        oracle = ICambiOracle(_oracle);
        params = _params;

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(LIQUIDATOR_ROLE, _admin);
        _grantRole(EMERGENCY_ROLE, _admin);
    }

    /**
     * @notice Schedule a liquidation for an undercollateralized position
     * @param vault Address of the vault containing the position
     * @param position Address of the position owner
     * @return liquidationId Unique identifier for the scheduled liquidation
     */
    function scheduleLiquidation(
        address vault,
        address position
    ) external onlyAuthorizedLiquidator whenNotPaused returns (bytes32 liquidationId) {
        require(vault != address(0) && position != address(0), "Invalid addresses");
        
        // Verify position is liquidatable
        require(RWAVault(vault).isLiquidatable(position), "Position not liquidatable");
        
        // Get position details
        (
            uint256 collateralAmount,
            uint256 syntheticAmount,
            uint256 collateralizationRatio,
            ,
            ,
        ) = RWAVault(vault).getPosition(position);
        
        require(collateralizationRatio < params.maxLiquidationRatio, "Ratio above liquidation threshold");
        
        // Generate liquidation ID
        liquidationId = keccak256(abi.encodePacked(vault, position, block.timestamp, nextLiquidationId++));
        
        // Schedule liquidation with delay (grace period)
        uint256 scheduledTime = block.timestamp + params.liquidationDelay;
        
        pendingLiquidations[liquidationId] = PendingLiquidation({
            vault: vault,
            position: position,
            scheduledTime: scheduledTime,
            collateralizationRatio: collateralizationRatio,
            executed: false
        });
        
        pendingLiquidationIds.push(liquidationId);
        
        emit LiquidationScheduled(
            liquidationId,
            vault,
            position,
            scheduledTime,
            collateralizationRatio
        );
        
        return liquidationId;
    }

    /**
     * @notice Execute a scheduled liquidation
     * @param liquidationId ID of the liquidation to execute
     */
    function executeLiquidation(
        bytes32 liquidationId
    ) external nonReentrant onlyAuthorizedLiquidator whenNotPaused {
        PendingLiquidation storage liquidation = pendingLiquidations[liquidationId];
        
        require(!liquidation.executed, "Already executed");
        require(liquidation.vault != address(0), "Invalid liquidation");
        require(block.timestamp >= liquidation.scheduledTime, "Grace period not over");
        
        // Verify position is still liquidatable
        require(
            RWAVault(liquidation.vault).isLiquidatable(liquidation.position),
            "Position no longer liquidatable"
        );
        
        // Get current position details
        (
            uint256 collateralAmount,
            uint256 syntheticAmount,
            uint256 currentRatio,
            ,
            ,
        ) = RWAVault(liquidation.vault).getPosition(liquidation.position);
        
        // Execute liquidation through vault
        RWAVault(liquidation.vault).liquidatePosition(liquidation.position);
        
        // Calculate rewards
        uint256 penalty = (collateralAmount * params.liquidationIncentive) / BASIS_POINTS;
        liquidatorRewards[msg.sender] += penalty;
        
        // Update stats
        stats.totalLiquidations++;
        stats.totalCollateralLiquidated += collateralAmount;
        stats.totalPenaltiesCollected += penalty;
        
        // Mark as executed
        liquidation.executed = true;
        
        emit LiquidationExecuted(
            liquidationId,
            liquidation.vault,
            liquidation.position,
            msg.sender,
            collateralAmount,
            penalty,
            penalty
        );
    }

    /**
     * @notice Cancel a pending liquidation
     * @param liquidationId ID of the liquidation to cancel
     * @param reason Reason for cancellation
     */
    function cancelLiquidation(
        bytes32 liquidationId,
        string calldata reason
    ) external onlyRole(EMERGENCY_ROLE) {
        PendingLiquidation storage liquidation = pendingLiquidations[liquidationId];
        require(!liquidation.executed, "Already executed");
        require(liquidation.vault != address(0), "Invalid liquidation");
        
        liquidation.executed = true; // Mark as executed to prevent future execution
        
        emit LiquidationCancelled(liquidationId, liquidation.vault, liquidation.position, reason);
    }

    /**
     * @notice Execute emergency liquidation without delay
     * @param vault Address of the vault containing the position
     * @param position Address of the position owner
     */
    function emergencyLiquidation(
        address vault,
        address position
    ) external nonReentrant onlyRole(EMERGENCY_ROLE) {
        require(vault != address(0) && position != address(0), "Invalid addresses");
        require(RWAVault(vault).isLiquidatable(position), "Position not liquidatable");
        
        // Get position details before liquidation
        (uint256 collateralAmount, , , , ,) = RWAVault(vault).getPosition(position);
        
        // Execute liquidation
        RWAVault(vault).liquidatePosition(position);
        
        // Update stats
        stats.totalLiquidations++;
        stats.totalCollateralLiquidated += collateralAmount;
        
        emit EmergencyLiquidation(vault, position, msg.sender, collateralAmount);
    }

    /**
     * @notice Batch liquidate multiple positions
     * @param vaults Array of vault addresses
     * @param positions Array of position addresses
     */
    function batchLiquidate(
        address[] calldata vaults,
        address[] calldata positions
    ) external nonReentrant onlyAuthorizedLiquidator whenNotPaused {
        require(vaults.length == positions.length, "Array length mismatch");
        require(vaults.length <= 10, "Too many liquidations"); // Prevent gas issues
        
        for (uint256 i = 0; i < vaults.length; i++) {
            if (RWAVault(vaults[i]).isLiquidatable(positions[i])) {
                try RWAVault(vaults[i]).liquidatePosition(positions[i]) {
                    stats.totalLiquidations++;
                } catch {
                    // Continue with next liquidation if one fails
                    continue;
                }
            }
        }
    }

    /**
     * @notice Get all pending liquidations
     * @return Array of pending liquidation IDs
     */
    function getPendingLiquidations() external view returns (bytes32[] memory) {
        uint256 pendingCount = 0;
        
        // Count pending liquidations
        for (uint256 i = 0; i < pendingLiquidationIds.length; i++) {
            if (!pendingLiquidations[pendingLiquidationIds[i]].executed &&
                block.timestamp >= pendingLiquidations[pendingLiquidationIds[i]].scheduledTime) {
                pendingCount++;
            }
        }
        
        // Create array of pending liquidations
        bytes32[] memory pending = new bytes32[](pendingCount);
        uint256 index = 0;
        
        for (uint256 i = 0; i < pendingLiquidationIds.length; i++) {
            bytes32 liquidationId = pendingLiquidationIds[i];
            PendingLiquidation memory liquidation = pendingLiquidations[liquidationId];
            
            if (!liquidation.executed && block.timestamp >= liquidation.scheduledTime) {
                pending[index] = liquidationId;
                index++;
            }
        }
        
        return pending;
    }

    /**
     * @notice Get liquidation statistics
     */
    function getLiquidationStats() external view returns (LiquidationStats memory) {
        return stats;
    }

    /**
     * @notice Withdraw liquidator rewards
     */
    function withdrawRewards() external {
        uint256 rewards = liquidatorRewards[msg.sender];
        require(rewards > 0, "No rewards to withdraw");
        
        liquidatorRewards[msg.sender] = 0;
        
        // In production, this would transfer actual tokens
        // For now, just reset the balance
        
        // payable(msg.sender).transfer(rewards);
    }

    /**
     * @notice Update liquidation parameters
     * @param newParams New liquidation parameters
     */
    function updateLiquidationParams(
        LiquidationParams calldata newParams
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newParams.liquidationDelay >= MIN_LIQUIDATION_DELAY, "Delay too short");
        require(newParams.liquidationDelay <= MAX_LIQUIDATION_DELAY, "Delay too long");
        require(newParams.liquidationIncentive <= MAX_LIQUIDATION_INCENTIVE, "Incentive too high");
        
        params = newParams;
    }

    /**
     * @notice Authorize liquidator
     * @param liquidator Address to authorize
     */
    function authorizeLiquidator(address liquidator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        authorizedLiquidators[liquidator] = true;
    }

    /**
     * @notice Revoke liquidator authorization
     * @param liquidator Address to revoke
     */
    function revokeLiquidator(address liquidator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        authorizedLiquidators[liquidator] = false;
    }

    /**
     * @notice Emergency pause liquidations
     */
    function emergencyPause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Emergency unpause liquidations
     */
    function emergencyUnpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }
}
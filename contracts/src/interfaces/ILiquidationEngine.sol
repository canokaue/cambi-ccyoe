// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ILiquidationEngine {
    struct LiquidationConfig {
        uint256 threshold; // Collateralization threshold in basis points
        uint256 bonus; // Liquidation bonus in basis points
        uint256 maxLiquidation; // Maximum liquidation percentage
        uint256 cooldownPeriod; // Time between liquidations
        bool isActive;
    }

    struct LiquidationData {
        uint256 totalLiquidated;
        uint256 liquidationCount;
        uint256 lastLiquidation;
        bool isLiquidatable;
    }

    event LiquidationTriggered(address indexed vault, address indexed liquidator, uint256 debtAmount, uint256 collateralSeized);
    event LiquidationThresholdUpdated(bytes32 indexed assetId, uint256 oldThreshold, uint256 newThreshold);
    event KeeperAdded(address indexed keeper);
    event KeeperRemoved(address indexed keeper);
    event EmergencyLiquidation(address indexed vault, uint256 amount, string reason);
    event VaultRegistered(address indexed vault, bytes32 indexed assetId);
    event VaultDeregistered(address indexed vault);

    function liquidate(address vault, uint256 amount) external;
    function batchLiquidate(address[] calldata vaults, uint256[] calldata amounts) external;
    function emergencyLiquidate(address vault, uint256 amount, string calldata reason) external;
    
    function registerVault(address vault, bytes32 assetId) external;
    function deregisterVault(address vault) external;
    
    function setLiquidationThreshold(bytes32 assetId, uint256 threshold) external;
    function setLiquidationBonus(bytes32 assetId, uint256 bonus) external;
    function setMaxLiquidationPercentage(bytes32 assetId, uint256 percentage) external;
    function setCooldownPeriod(bytes32 assetId, uint256 period) external;
    
    function addKeeper(address keeper) external;
    function removeKeeper(address keeper) external;
    
    function isLiquidatable(address vault) external view returns (bool);
    function getLiquidationThreshold(bytes32 assetId) external view returns (uint256);
    function getLiquidationBonus(bytes32 assetId) external view returns (uint256);
    function calculateLiquidationBonus(bytes32 assetId, uint256 amount) external view returns (uint256);
    function getLiquidatableVaults() external view returns (address[] memory);
    function getLiquidationStats(address vault) external view returns (uint256 totalLiquidated, uint256 liquidationCount);
    function getTotalLiquidationVolume() external view returns (uint256);
    function isVaultRegistered(address vault) external view returns (bool);
    function getVaultAssetId(address vault) external view returns (bytes32);
    function getLiquidationConfig(bytes32 assetId) external view returns (LiquidationConfig memory);
}

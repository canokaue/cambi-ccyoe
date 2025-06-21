// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ICCYOECore {
    struct AssetConfig {
        address vaultAddress;
        uint256 targetYield;
        uint256 supplyCap;
        uint256 currentSupply;
        bool isActive;
        uint256 lastRebalance;
    }

    struct DistributionConfig {
        uint256 underSuppliedAllocation;
        uint256 strategicGrowthAllocation;
        uint256 proportionalAllocation;
        uint256 treasuryAllocation;
        uint256 rebalanceThreshold;
        uint256 rebalanceFrequency;
    }

    event YieldOptimized(bytes32 indexed asset, uint256 oldYield, uint256 newYield, uint256 timestamp);
    event ExcessYieldDistributed(uint256 totalExcess, uint256 distributed, uint256 timestamp);
    event AssetConfigUpdated(bytes32 indexed asset, uint256 targetYield, uint256 supplyCap);
    event DistributionConfigUpdated(uint256[4] allocations, uint256 threshold, uint256 frequency);
    event EmergencyRebalance(bytes32 indexed asset, uint256 yield, string reason);

    function optimizeYields() external;
    function emergencyRebalance(bytes32 assetId, uint256 newYield, string calldata reason) external;
    function updateAssetConfig(bytes32 assetId, address vaultAddress, uint256 targetYield, uint256 supplyCap, bool isActive) external;
    function updateDistributionConfig(uint256 underSupplied, uint256 strategic, uint256 proportional, uint256 treasuryAlloc, uint256 threshold, uint256 frequency) external;
    function updateAssetSupply(bytes32 assetId, uint256 newSupply) external;
    function getAssetConfig(bytes32 assetId) external view returns (AssetConfig memory);
    function getAllAssetYields() external view returns (uint256[] memory, address[] memory);
}

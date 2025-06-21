// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IVaultManager {
    struct VaultInfo {
        address vaultAddress;
        bytes32 assetId;
        uint256 totalSupply;
        uint256 collateralRatio;
        bool isActive;
    }

    event VaultCreated(bytes32 indexed assetId, address indexed vaultAddress);
    event VaultUpdated(bytes32 indexed assetId, uint256 newSupply, uint256 newRatio);

    function createVault(bytes32 assetId, address vaultAddress) external;
    function updateVaultSupply(bytes32 assetId, uint256 newSupply) external;
    function getVaultInfo(bytes32 assetId) external view returns (VaultInfo memory);
    function getAllVaults() external view returns (VaultInfo[] memory);
}

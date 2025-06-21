// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IVaultManager.sol";
import "./interfaces/ICCYOECore.sol";

/**
 * @title VaultManager
 * @notice Manages individual asset vaults for the CCYOE system
 */
contract VaultManager is IVaultManager, AccessControl, ReentrancyGuard {
    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");
    
    mapping(bytes32 => VaultInfo) public vaults;
    bytes32[] public activeVaults;
    
    ICCYOECore public ccyoeCore;
    
    modifier onlyVaultAdmin() {
        require(hasRole(VAULT_ADMIN_ROLE, msg.sender), "Not authorized vault admin");
        _;
    }
    
    constructor(address admin, address _ccyoeCore) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_ADMIN_ROLE, admin);
        ccyoeCore = ICCYOECore(_ccyoeCore);
    }
    
    function createVault(bytes32 assetId, address vaultAddress) external override onlyVaultAdmin {
        require(vaultAddress != address(0), "Invalid vault address");
        require(vaults[assetId].vaultAddress == address(0), "Vault already exists");
        
        vaults[assetId] = VaultInfo({
            vaultAddress: vaultAddress,
            assetId: assetId,
            totalSupply: 0,
            collateralRatio: 15000, // 150% default
            isActive: true
        });
        
        activeVaults.push(assetId);
        
        emit VaultCreated(assetId, vaultAddress);
    }
    
    function updateVaultSupply(bytes32 assetId, uint256 newSupply) external override {
        VaultInfo storage vault = vaults[assetId];
        require(vault.vaultAddress != address(0), "Vault does not exist");
        require(msg.sender == vault.vaultAddress, "Only vault can update supply");
        
        vault.totalSupply = newSupply;
        
        // Notify CCYOE core of supply change
        ccyoeCore.updateAssetSupply(assetId, newSupply);
        
        emit VaultUpdated(assetId, newSupply, vault.collateralRatio);
    }
    
    function getVaultInfo(bytes32 assetId) external view override returns (VaultInfo memory) {
        return vaults[assetId];
    }
    
    function getAllVaults() external view override returns (VaultInfo[] memory) {
        VaultInfo[] memory allVaults = new VaultInfo[](activeVaults.length);
        
        for (uint i = 0; i < activeVaults.length; i++) {
            allVaults[i] = vaults[activeVaults[i]];
        }
        
        return allVaults;
    }
    
    function setVaultCollateralRatio(bytes32 assetId, uint256 newRatio) external onlyVaultAdmin {
        require(vaults[assetId].vaultAddress != address(0), "Vault does not exist");
        require(newRatio >= 11000, "Ratio too low"); // Min 110%
        
        vaults[assetId].collateralRatio = newRatio;
        
        emit VaultUpdated(assetId, vaults[assetId].totalSupply, newRatio);
    }
    
    function deactivateVault(bytes32 assetId) external onlyVaultAdmin {
        require(vaults[assetId].vaultAddress != address(0), "Vault does not exist");
        
        vaults[assetId].isActive = false;
        
        // Remove from active vaults array
        for (uint i = 0; i < activeVaults.length; i++) {
            if (activeVaults[i] == assetId) {
                activeVaults[i] = activeVaults[activeVaults.length - 1];
                activeVaults.pop();
                break;
            }
        }
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IYieldDistributor.sol";

/**
 * @title YieldDistributor
 * @notice Handles yield distribution and boosting for CCYOE
 */
contract YieldDistributor is IYieldDistributor, AccessControl, ReentrancyGuard {
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    
    mapping(address => uint256) public vaultYields;
    mapping(address => uint256) public yieldBoosts;
    mapping(address => uint256) public lastDistribution;
    
    modifier onlyDistributor() {
        require(hasRole(DISTRIBUTOR_ROLE, msg.sender), "Not authorized distributor");
        _;
    }
    
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DISTRIBUTOR_ROLE, admin);
    }
    
    function distributeTo(address recipient, uint256 amount) external override nonReentrant onlyDistributor {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");
        
        // Implementation would transfer yield tokens or update balances
        // This is a simplified version for the core logic
        lastDistribution[recipient] = block.timestamp;
        
        emit YieldDistributed(recipient, amount, block.timestamp);
    }
    
    function boostAssetYield(address vault, uint256 boostAmount) external override nonReentrant onlyDistributor {
        require(vault != address(0), "Invalid vault");
        require(boostAmount > 0, "Invalid boost amount");
        
        yieldBoosts[vault] += boostAmount;
        uint256 newYield = vaultYields[vault] + boostAmount;
        vaultYields[vault] = newYield;
        
        emit AssetYieldBoosted(vault, boostAmount, newYield);
    }
    
    function setAssetYield(address vault, uint256 newYield) external override nonReentrant onlyDistributor {
        require(vault != address(0), "Invalid vault");
        
        vaultYields[vault] = newYield;
        yieldBoosts[vault] = 0; // Reset boost when setting absolute yield
        
        emit YieldDistributed(vault, newYield, block.timestamp);
    }
    
    function getVaultYield(address vault) external view override returns (uint256) {
        return vaultYields[vault];
    }
    
    function getVaultBoost(address vault) external view returns (uint256) {
        return yieldBoosts[vault];
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IRWAVault {
    struct RWAInfo {
        address rwaToken;
        uint256 allocation;
        uint256 expectedYield;
        uint256 maturityDate;
        string description;
        bool isActive;
        uint256 addedTimestamp;
    }

    struct PortfolioMetrics {
        uint256 totalValue;
        uint256 weightedYield;
        uint256 diversificationScore;
        uint256 maturityProfile;
        uint256 riskScore;
    }

    event RWAAdded(address indexed rwaToken, uint256 allocation, uint256 expectedYield);
    event RWARemoved(address indexed rwaToken, uint256 recoveredAmount);
    event RWAMatured(address indexed rwaToken, uint256 finalYield, uint256 payout);
    event PortfolioRebalanced(uint256 totalValue, uint256 newTargetYield);
    event EmergencyWithdrawal(address indexed rwaToken, uint256 amount, string reason);
    event YieldDistributed(uint256 amount, uint256 timestamp);

    function addRWA(address rwaToken, uint256 allocation, uint256 expectedYield, string calldata description) external;
    function removeRWA(address rwaToken) external;
    function rebalancePortfolio() external;
    function processMaturedRWA(address rwaToken) external;
    function emergencyWithdraw(address rwaToken, string calldata reason) external;
    function distributeYield() external;
    
    function getRWAInfo(address rwaToken) external view returns (RWAInfo memory);
    function getAllRWAs() external view returns (address[] memory);
    function getPortfolioMetrics() external view returns (PortfolioMetrics memory);
    function isRWAActive(address rwaToken) external view returns (bool);
    function getRWAAllocation(address rwaToken) external view returns (uint256);
    function getRWAYield(address rwaToken) external view returns (uint256);
    function getPortfolioYield() external view returns (uint256);
    function totalRWAValue() external view returns (uint256);
    function getRWACount() external view returns (uint256);
    function getAccruedYield() external view returns (uint256);
    function getRWAHealth(address rwaToken) external view returns (bool isHealthy, string memory status);
    function lastRebalance() external view returns (uint256);
    
    function updateAllocationLimits(uint256 maxSingleAsset, uint256 maxCategory) external;
    function setMaturityThreshold(uint256 daysBeforeMaturity) external;
    function updateRiskParameters(uint256 maxRiskScore, uint256 minDiversification) external;
}

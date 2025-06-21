// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IYieldDistributor {
    event YieldDistributed(address indexed vault, uint256 amount, uint256 timestamp);
    event AssetYieldBoosted(address indexed vault, uint256 boostAmount, uint256 newYield);

    function distributeTo(address recipient, uint256 amount) external;
    function boostAssetYield(address vault, uint256 boostAmount) external;
    function setAssetYield(address vault, uint256 newYield) external;
    function getVaultYield(address vault) external view returns (uint256);
}

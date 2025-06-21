// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface ICambiOracle {
    struct AssetYieldData {
        uint256 yield;
        uint256 timestamp;
        uint256 confidence;
        bool isValid;
    }

    event YieldUpdated(bytes32 indexed assetId, uint256 oldYield, uint256 newYield, uint256 timestamp);
    event OracleConfigUpdated(bytes32 indexed assetId, uint256 heartbeat, uint256 threshold);

    function updateAssetYield(bytes32 assetId, uint256 newYield, uint256 confidence) external;
    function getAssetYield(bytes32 assetId) external view returns (uint256);
    function getAssetYieldData(bytes32 assetId) external view returns (AssetYieldData memory);
    function isYieldDataValid(bytes32 assetId) external view returns (bool);
}

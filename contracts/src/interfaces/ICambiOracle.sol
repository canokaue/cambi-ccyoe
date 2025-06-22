// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title ICambiOracle
 * @notice Interface for Cambi Protocol's RWA Oracle system
 */
interface ICambiOracle {
    /**
     * @notice Get current yield for an asset
     * @param assetId The asset identifier (e.g., keccak256("cmBTC"))
     * @return yield The current yield in basis points
     */
    function getAssetYield(bytes32 assetId) external view returns (uint256 yield);

    /**
     * @notice Get full yield data for an asset
     * @param assetId The asset identifier
     * @return yield Current yield in basis points
     * @return confidence Confidence score (0-100)
     * @return timestamp Last update timestamp
     * @return isValid Whether the data is valid
     */
    function getAssetYieldData(bytes32 assetId) 
        external 
        view 
        returns (uint256 yield, uint256 confidence, uint256 timestamp, bool isValid);

    /**
     * @notice Check if yield data is valid and fresh
     * @param assetId The asset identifier
     * @return true if data is valid and fresh
     */
    function isYieldDataValid(bytes32 assetId) external view returns (bool);

    /**
     * @notice Submit yield data (only for authorized providers)
     * @param assetId The asset identifier
     * @param yield The yield in basis points
     * @param confidence The confidence score (0-100)
     */
    function submitYieldData(bytes32 assetId, uint256 yield, uint256 confidence) external;

    /**
     * @notice Emergency yield override
     * @param assetId The asset identifier
     * @param yield The new yield in basis points
     * @param reason The reason for emergency override
     */
    function emergencySetYield(bytes32 assetId, uint256 yield, string calldata reason) external;

    // Events
    event YieldUpdated(bytes32 indexed assetId, uint256 oldYield, uint256 newYield, uint256 confidence, uint256 timestamp);
    event EmergencyYieldSet(bytes32 indexed assetId, uint256 yield, address indexed setter, string reason);
    event DataSubmitted(bytes32 indexed assetId, address indexed provider, uint256 yield, uint256 confidence);
}

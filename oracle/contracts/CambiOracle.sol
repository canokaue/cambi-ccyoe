// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title CambiOracle
 * @notice Specialized oracle for Real World Asset yields in Cambi Protocol
 * @dev Aggregates yield data from multiple sources with confidence scoring
 */
contract CambiOracle is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
    bytes32 public constant DATA_PROVIDER_ROLE = keccak256("DATA_PROVIDER_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    struct AssetYieldData {
        uint256 yield;           // Current yield in basis points
        uint256 timestamp;       // Last update timestamp
        uint256 confidence;      // Confidence score (0-100)
        bool isValid;           // Whether data is valid
        uint256 heartbeat;      // Maximum time between updates
        uint256 deviationThreshold; // Maximum allowed deviation
    }

    struct DataSource {
        address provider;
        uint256 weight;         // Weight in aggregation (0-10000)
        bool isActive;
        uint256 lastUpdate;
        string name;
    }

    struct YieldSubmission {
        uint256 yield;
        uint256 timestamp;
        uint256 confidence;
        address provider;
    }

    mapping(bytes32 => AssetYieldData) public assetYields;
    mapping(bytes32 => DataSource[]) public assetSources;
    mapping(bytes32 => mapping(address => YieldSubmission)) public latestSubmissions;
    mapping(bytes32 => uint256[]) public yieldHistory; // For trend analysis
    mapping(address => bool) public authorizedCallers;

    uint256 public constant MIN_CONFIDENCE = 50;
    uint256 public constant MAX_SOURCES = 10;
    uint256 public constant YIELD_HISTORY_LENGTH = 100;

    event YieldUpdated(bytes32 indexed assetId, uint256 oldYield, uint256 newYield, uint256 confidence, uint256 timestamp);
    event SourceAdded(bytes32 indexed assetId, address indexed provider, uint256 weight, string name);
    event SourceUpdated(bytes32 indexed assetId, address indexed provider, uint256 newWeight, bool isActive);
    event EmergencyYieldSet(bytes32 indexed assetId, uint256 yield, address indexed setter, string reason);
    event DataSubmitted(bytes32 indexed assetId, address indexed provider, uint256 yield, uint256 confidence);

    modifier onlyAuthorizedCaller() {
        require(authorizedCallers[msg.sender] || hasRole(ORACLE_ADMIN_ROLE, msg.sender), "Unauthorized caller");
        _;
    }

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, admin);
        authorizedCallers[admin] = true;
    }

    /**
     * @notice Submit yield data from authorized provider
     */
    function submitYieldData(
        bytes32 assetId,
        uint256 yield,
        uint256 confidence
    ) external onlyRole(DATA_PROVIDER_ROLE) whenNotPaused nonReentrant {
        require(confidence >= MIN_CONFIDENCE && confidence <= 100, "Invalid confidence");
        require(yield > 0 && yield <= 10000, "Invalid yield"); // Max 100%

        // Store submission
        latestSubmissions[assetId][msg.sender] = YieldSubmission({
            yield: yield,
            timestamp: block.timestamp,
            confidence: confidence,
            provider: msg.sender
        });

        emit DataSubmitted(assetId, msg.sender, yield, confidence);

        // Trigger aggregation if enough recent data
        _tryAggregateYield(assetId);
    }

    /**
     * @notice Aggregate yield data from multiple sources
     */
    function _tryAggregateYield(bytes32 assetId) internal {
        DataSource[] storage sources = assetSources[assetId];
        if (sources.length == 0) return;

        uint256 weightedYield = 0;
        uint256 weightedConfidence = 0;
        uint256 totalWeight = 0;
        uint256 validSources = 0;
        uint256 currentTime = block.timestamp;

        // Aggregate from active sources with recent data
        for (uint256 i = 0; i < sources.length; i++) {
            DataSource storage source = sources[i];
            if (!source.isActive) continue;

            YieldSubmission storage submission = latestSubmissions[assetId][source.provider];
            
            // Check if data is recent enough
            AssetYieldData storage assetData = assetYields[assetId];
            if (currentTime - submission.timestamp > assetData.heartbeat) continue;

            // Apply deviation check
            if (assetData.yield > 0) {
                uint256 deviation = submission.yield > assetData.yield 
                    ? submission.yield - assetData.yield
                    : assetData.yield - submission.yield;
                
                if (deviation * 10000 / assetData.yield > assetData.deviationThreshold) {
                    // Log but don't exclude - may indicate market change
                }
            }

            weightedYield += submission.yield * source.weight;
            weightedConfidence += submission.confidence * source.weight;
            totalWeight += source.weight;
            validSources++;
        }

        // Need at least 2 sources for valid aggregation
        if (validSources < 2 || totalWeight == 0) return;

        uint256 aggregatedYield = weightedYield / totalWeight;
        uint256 aggregatedConfidence = weightedConfidence / totalWeight;

        // Update asset data
        AssetYieldData storage assetData = assetYields[assetId];
        uint256 oldYield = assetData.yield;

        assetData.yield = aggregatedYield;
        assetData.confidence = aggregatedConfidence;
        assetData.timestamp = currentTime;
        assetData.isValid = true;

        // Update history
        _updateYieldHistory(assetId, aggregatedYield);

        emit YieldUpdated(assetId, oldYield, aggregatedYield, aggregatedConfidence, currentTime);
    }

    /**
     * @notice Update yield history for trend analysis
     */
    function _updateYieldHistory(bytes32 assetId, uint256 yield) internal {
        uint256[] storage history = yieldHistory[assetId];
        
        if (history.length >= YIELD_HISTORY_LENGTH) {
            // Shift array left
            for (uint256 i = 0; i < YIELD_HISTORY_LENGTH - 1; i++) {
                history[i] = history[i + 1];
            }
            history[YIELD_HISTORY_LENGTH - 1] = yield;
        } else {
            history.push(yield);
        }
    }

    /**
     * @notice Get current yield for an asset
     */
    function getAssetYield(bytes32 assetId) external view onlyAuthorizedCaller returns (uint256) {
        AssetYieldData storage data = assetYields[assetId];
        require(data.isValid, "Invalid yield data");
        require(block.timestamp - data.timestamp <= data.heartbeat, "Stale data");
        
        return data.yield;
    }

    /**
     * @notice Get full yield data for an asset
     */
    function getAssetYieldData(bytes32 assetId) external view returns (AssetYieldData memory) {
        return assetYields[assetId];
    }

    /**
     * @notice Check if yield data is valid and fresh
     */
    function isYieldDataValid(bytes32 assetId) external view returns (bool) {
        AssetYieldData storage data = assetYields[assetId];
        return data.isValid && 
               block.timestamp - data.timestamp <= data.heartbeat &&
               data.confidence >= MIN_CONFIDENCE;
    }

    /**
     * @notice Emergency override for yield data
     */
    function emergencySetYield(
        bytes32 assetId,
        uint256 yield,
        string calldata reason
    ) external onlyRole(EMERGENCY_ROLE) {
        AssetYieldData storage data = assetYields[assetId];
        data.yield = yield;
        data.timestamp = block.timestamp;
        data.confidence = 95; // High confidence for emergency data
        data.isValid = true;

        emit EmergencyYieldSet(assetId, yield, msg.sender, reason);
    }

    /**
     * @notice Add data source for an asset
     */
    function addDataSource(
        bytes32 assetId,
        address provider,
        uint256 weight,
        string calldata name
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(provider != address(0), "Invalid provider");
        require(weight > 0 && weight <= 10000, "Invalid weight");
        require(assetSources[assetId].length < MAX_SOURCES, "Too many sources");

        assetSources[assetId].push(DataSource({
            provider: provider,
            weight: weight,
            isActive: true,
            lastUpdate: block.timestamp,
            name: name
        }));

        // Grant DATA_PROVIDER_ROLE if not already granted
        if (!hasRole(DATA_PROVIDER_ROLE, provider)) {
            _grantRole(DATA_PROVIDER_ROLE, provider);
        }

        emit SourceAdded(assetId, provider, weight, name);
    }

    /**
     * @notice Update data source configuration
     */
    function updateDataSource(
        bytes32 assetId,
        address provider,
        uint256 newWeight,
        bool isActive
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        DataSource[] storage sources = assetSources[assetId];
        
        for (uint256 i = 0; i < sources.length; i++) {
            if (sources[i].provider == provider) {
                sources[i].weight = newWeight;
                sources[i].isActive = isActive;
                sources[i].lastUpdate = block.timestamp;
                
                emit SourceUpdated(assetId, provider, newWeight, isActive);
                return;
            }
        }
        
        revert("Source not found");
    }

    /**
     * @notice Configure asset parameters
     */
    function configureAsset(
        bytes32 assetId,
        uint256 heartbeat,
        uint256 deviationThreshold
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(heartbeat > 0 && heartbeat <= 86400, "Invalid heartbeat"); // Max 24 hours
        require(deviationThreshold <= 5000, "Invalid deviation threshold"); // Max 50%

        AssetYieldData storage data = assetYields[assetId];
        data.heartbeat = heartbeat;
        data.deviationThreshold = deviationThreshold;
        
        if (!data.isValid) {
            data.isValid = false; // Will be set to true when first data arrives
            data.timestamp = block.timestamp;
        }
    }

    /**
     * @notice Authorize caller for yield data access
     */
    function setAuthorizedCaller(address caller, bool authorized) external onlyRole(ORACLE_ADMIN_ROLE) {
        authorizedCallers[caller] = authorized;
    }

    /**
     * @notice Get yield history for trend analysis
     */
    function getYieldHistory(bytes32 assetId) external view returns (uint256[] memory) {
        return yieldHistory[assetId];
    }

    /**
     * @notice Get all data sources for an asset
     */
    function getAssetSources(bytes32 assetId) external view returns (DataSource[] memory) {
        return assetSources[assetId];
    }

    /**
     * @notice Force aggregation for an asset
     */
    function forceAggregation(bytes32 assetId) external onlyRole(ORACLE_ADMIN_ROLE) {
        _tryAggregateYield(assetId);
    }

    /**
     * @notice Pause oracle operations
     */
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause oracle operations
     */
    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }
}
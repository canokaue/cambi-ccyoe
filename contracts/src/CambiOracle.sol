// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "./interfaces/ICambiOracle.sol";

/**
 * @title CambiOracle
 * @notice On-chain oracle for Real World Asset yields in the Cambi Protocol
 * @dev Aggregates data from multiple sources with confidence scoring
 */
contract CambiOracle is ICambiOracle, AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");
    bytes32 public constant DATA_PROVIDER_ROLE = keccak256("DATA_PROVIDER_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    struct AssetYieldData {
        uint256 yield;              // Current yield in basis points
        uint256 confidence;         // Confidence score (0-100)
        uint256 timestamp;          // Last update timestamp
        bool isValid;               // Data validity flag
    }

    struct DataSource {
        address provider;           // Data provider address
        uint256 weight;            // Weight in aggregation (0-10000)
        uint256 lastUpdate;        // Last update timestamp
        bool isActive;             // Source status
        string name;               // Human readable name
    }

    struct AggregationConfig {
        uint256 heartbeat;         // Maximum time between updates (seconds)
        uint256 deviationThreshold; // Maximum deviation from average (basis points)
        uint256 minConfidence;     // Minimum confidence score to accept
        uint256 minSources;        // Minimum sources required for valid data
        bool emergencyMode;        // Emergency override mode
    }

    // Asset yield data
    mapping(bytes32 => AssetYieldData) private assetYields;
    
    // Data sources for each asset
    mapping(bytes32 => DataSource[]) private assetDataSources;
    mapping(bytes32 => mapping(address => uint256)) private providerSubmissions;
    mapping(bytes32 => uint256) private lastAggregation;
    
    // Configuration
    mapping(bytes32 => AggregationConfig) private aggregationConfigs;
    
    // Emergency overrides
    mapping(bytes32 => uint256) private emergencyYields;
    mapping(bytes32 => address) private emergencySetters;
    
    // Constants
    uint256 public constant MAX_CONFIDENCE = 100;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_HEARTBEAT = 24 hours;
    uint256 public constant MIN_HEARTBEAT = 5 minutes;

    event YieldUpdated(
        bytes32 indexed assetId,
        uint256 oldYield,
        uint256 newYield,
        uint256 confidence,
        uint256 timestamp
    );
    
    event EmergencyYieldSet(
        bytes32 indexed assetId,
        uint256 yield,
        address indexed setter,
        string reason
    );
    
    event DataSubmitted(
        bytes32 indexed assetId,
        address indexed provider,
        uint256 yield,
        uint256 confidence
    );
    
    event DataSourceAdded(
        bytes32 indexed assetId,
        address indexed provider,
        uint256 weight,
        string name
    );
    
    event DataSourceUpdated(
        bytes32 indexed assetId,
        address indexed provider,
        uint256 newWeight,
        bool isActive
    );

    modifier onlyDataProvider() {
        require(hasRole(DATA_PROVIDER_ROLE, msg.sender), "Not authorized data provider");
        _;
    }

    modifier validAsset(bytes32 assetId) {
        require(aggregationConfigs[assetId].heartbeat > 0, "Asset not configured");
        _;
    }

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
        _grantRole(EMERGENCY_ROLE, admin);
        
        // Initialize default assets
        _initializeAsset(keccak256("cmBTC"), 1 hours, 200, 80, 2); // 1h heartbeat, 2% deviation, 80% confidence, 2 sources
        _initializeAsset(keccak256("cmUSD"), 1 hours, 300, 85, 2); // More stringent for USD
        _initializeAsset(keccak256("cmBRL"), 1 hours, 500, 80, 2); // Higher deviation tolerance for BRL
    }

    /**
     * @notice Submit yield data from authorized provider
     * @param assetId Asset identifier
     * @param yield Yield in basis points
     * @param confidence Confidence score (0-100)
     */
    function submitYieldData(
        bytes32 assetId,
        uint256 yield,
        uint256 confidence
    ) external override nonReentrant onlyDataProvider validAsset(assetId) whenNotPaused {
        require(yield <= 50000, "Yield too high"); // Max 500% yield sanity check
        require(confidence <= MAX_CONFIDENCE, "Invalid confidence");
        
        // Store provider submission
        providerSubmissions[assetId][msg.sender] = yield;
        
        emit DataSubmitted(assetId, msg.sender, yield, confidence);
        
        // Try to aggregate if enough time has passed
        _tryAggregateData(assetId);
    }

    /**
     * @notice Emergency yield override
     * @param assetId Asset identifier
     * @param yield Emergency yield value
     * @param reason Reason for emergency override
     */
    function emergencySetYield(
        bytes32 assetId,
        uint256 yield,
        string calldata reason
    ) external override onlyRole(EMERGENCY_ROLE) validAsset(assetId) {
        require(yield <= 50000, "Yield too high");
        
        emergencyYields[assetId] = yield;
        emergencySetters[assetId] = msg.sender;
        aggregationConfigs[assetId].emergencyMode = true;
        
        // Update asset yield data
        assetYields[assetId] = AssetYieldData({
            yield: yield,
            confidence: 100, // Emergency data has max confidence
            timestamp: block.timestamp,
            isValid: true
        });
        
        emit EmergencyYieldSet(assetId, yield, msg.sender, reason);
        emit YieldUpdated(assetId, assetYields[assetId].yield, yield, 100, block.timestamp);
    }

    /**
     * @notice Clear emergency mode for asset
     * @param assetId Asset identifier
     */
    function clearEmergencyMode(bytes32 assetId) external onlyRole(EMERGENCY_ROLE) {
        aggregationConfigs[assetId].emergencyMode = false;
        delete emergencyYields[assetId];
        delete emergencySetters[assetId];
    }

    /**
     * @notice Get current yield for asset
     * @param assetId Asset identifier
     * @return yield Current yield in basis points
     */
    function getAssetYield(bytes32 assetId) external view override returns (uint256 yield) {
        return assetYields[assetId].yield;
    }

    /**
     * @notice Get full yield data for asset
     * @param assetId Asset identifier
     * @return yield Current yield in basis points
     * @return confidence Confidence score (0-100)
     * @return timestamp Last update timestamp
     * @return isValid Data validity flag
     */
    function getAssetYieldData(bytes32 assetId) external view override returns (
        uint256 yield,
        uint256 confidence,
        uint256 timestamp,
        bool isValid
    ) {
        AssetYieldData memory data = assetYields[assetId];
        return (data.yield, data.confidence, data.timestamp, data.isValid);
    }

    /**
     * @notice Check if yield data is valid and fresh
     * @param assetId Asset identifier
     * @return true if data is valid and fresh
     */
    function isYieldDataValid(bytes32 assetId) external view override returns (bool) {
        AssetYieldData memory data = assetYields[assetId];
        AggregationConfig memory config = aggregationConfigs[assetId];
        
        return data.isValid && 
               (block.timestamp - data.timestamp) <= config.heartbeat &&
               data.confidence >= config.minConfidence;
    }

    /**
     * @notice Add data source for asset
     * @param assetId Asset identifier
     * @param provider Provider address
     * @param weight Weight in aggregation (0-10000)
     * @param name Human readable name
     */
    function addDataSource(
        bytes32 assetId,
        address provider,
        uint256 weight,
        string calldata name
    ) external onlyRole(ORACLE_ADMIN_ROLE) validAsset(assetId) {
        require(provider != address(0), "Invalid provider");
        require(weight <= BASIS_POINTS, "Weight too high");
        require(bytes(name).length > 0, "Name required");
        
        // Check if provider already exists
        DataSource[] storage sources = assetDataSources[assetId];
        for (uint256 i = 0; i < sources.length; i++) {
            require(sources[i].provider != provider, "Provider already exists");
        }
        
        sources.push(DataSource({
            provider: provider,
            weight: weight,
            lastUpdate: 0,
            isActive: true,
            name: name
        }));
        
        // Grant data provider role
        _grantRole(DATA_PROVIDER_ROLE, provider);
        
        emit DataSourceAdded(assetId, provider, weight, name);
    }

    /**
     * @notice Update data source configuration
     * @param assetId Asset identifier
     * @param provider Provider address
     * @param newWeight New weight
     * @param isActive Active status
     */
    function updateDataSource(
        bytes32 assetId,
        address provider,
        uint256 newWeight,
        bool isActive
    ) external onlyRole(ORACLE_ADMIN_ROLE) validAsset(assetId) {
        require(newWeight <= BASIS_POINTS, "Weight too high");
        
        DataSource[] storage sources = assetDataSources[assetId];
        bool found = false;
        
        for (uint256 i = 0; i < sources.length; i++) {
            if (sources[i].provider == provider) {
                sources[i].weight = newWeight;
                sources[i].isActive = isActive;
                found = true;
                break;
            }
        }
        
        require(found, "Provider not found");
        
        emit DataSourceUpdated(assetId, provider, newWeight, isActive);
    }

    /**
     * @notice Configure asset aggregation parameters
     * @param assetId Asset identifier
     * @param heartbeat Maximum time between updates
     * @param deviationThreshold Maximum deviation tolerance
     * @param minConfidence Minimum confidence required
     * @param minSources Minimum active sources required
     */
    function configureAsset(
        bytes32 assetId,
        uint256 heartbeat,
        uint256 deviationThreshold,
        uint256 minConfidence,
        uint256 minSources
    ) external onlyRole(ORACLE_ADMIN_ROLE) {
        require(heartbeat >= MIN_HEARTBEAT && heartbeat <= MAX_HEARTBEAT, "Invalid heartbeat");
        require(deviationThreshold <= 5000, "Deviation too high"); // Max 50%
        require(minConfidence <= MAX_CONFIDENCE, "Invalid confidence");
        require(minSources > 0 && minSources <= 10, "Invalid source count");
        
        aggregationConfigs[assetId] = AggregationConfig({
            heartbeat: heartbeat,
            deviationThreshold: deviationThreshold,
            minConfidence: minConfidence,
            minSources: minSources,
            emergencyMode: false
        });
    }

    /**
     * @notice Get asset configuration
     * @param assetId Asset identifier
     */
    function getAssetConfig(bytes32 assetId) external view returns (AggregationConfig memory) {
        return aggregationConfigs[assetId];
    }

    /**
     * @notice Get data sources for asset
     * @param assetId Asset identifier
     */
    function getDataSources(bytes32 assetId) external view returns (DataSource[] memory) {
        return assetDataSources[assetId];
    }

    /**
     * @notice Manual trigger for data aggregation
     * @param assetId Asset identifier
     */
    function triggerAggregation(bytes32 assetId) external onlyRole(ORACLE_ADMIN_ROLE) validAsset(assetId) {
        _aggregateData(assetId);
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

    // Internal functions

    function _initializeAsset(
        bytes32 assetId,
        uint256 heartbeat,
        uint256 deviationThreshold,
        uint256 minConfidence,
        uint256 minSources
    ) internal {
        aggregationConfigs[assetId] = AggregationConfig({
            heartbeat: heartbeat,
            deviationThreshold: deviationThreshold,
            minConfidence: minConfidence,
            minSources: minSources,
            emergencyMode: false
        });
    }

    function _tryAggregateData(bytes32 assetId) internal {
        AggregationConfig memory config = aggregationConfigs[assetId];
        
        // Check if enough time has passed since last aggregation
        if (block.timestamp - lastAggregation[assetId] >= config.heartbeat / 4) {
            _aggregateData(assetId);
        }
    }

    function _aggregateData(bytes32 assetId) internal {
        if (aggregationConfigs[assetId].emergencyMode) {
            return; // Skip aggregation in emergency mode
        }
        
        DataSource[] memory sources = assetDataSources[assetId];
        AggregationConfig memory config = aggregationConfigs[assetId];
        
        uint256[] memory yields = new uint256[](sources.length);
        uint256[] memory weights = new uint256[](sources.length);
        uint256 activeSourceCount = 0;
        uint256 totalWeight = 0;
        
        // Collect active source data
        for (uint256 i = 0; i < sources.length; i++) {
            if (sources[i].isActive && providerSubmissions[assetId][sources[i].provider] > 0) {
                yields[activeSourceCount] = providerSubmissions[assetId][sources[i].provider];
                weights[activeSourceCount] = sources[i].weight;
                totalWeight += sources[i].weight;
                activeSourceCount++;
            }
        }
        
        // Check minimum sources requirement
        if (activeSourceCount < config.minSources) {
            return; // Not enough sources
        }
        
        // Calculate weighted average
        uint256 weightedSum = 0;
        for (uint256 i = 0; i < activeSourceCount; i++) {
            weightedSum += yields[i] * weights[i];
        }
        
        uint256 aggregatedYield = weightedSum / totalWeight;
        
        // Calculate confidence based on deviation
        uint256 confidence = _calculateConfidence(yields, activeSourceCount, aggregatedYield);
        
        // Check minimum confidence
        if (confidence < config.minConfidence) {
            return; // Confidence too low
        }
        
        // Update asset yield data
        uint256 oldYield = assetYields[assetId].yield;
        assetYields[assetId] = AssetYieldData({
            yield: aggregatedYield,
            confidence: confidence,
            timestamp: block.timestamp,
            isValid: true
        });
        
        lastAggregation[assetId] = block.timestamp;
        
        emit YieldUpdated(assetId, oldYield, aggregatedYield, confidence, block.timestamp);
    }

    function _calculateConfidence(
        uint256[] memory yields,
        uint256 count,
        uint256 average
    ) internal pure returns (uint256) {
        if (count == 0) return 0;
        if (count == 1) return 70; // Lower confidence for single source
        
        // Calculate standard deviation
        uint256 sumSquaredDeviations = 0;
        for (uint256 i = 0; i < count; i++) {
            uint256 deviation = yields[i] > average ? yields[i] - average : average - yields[i];
            sumSquaredDeviations += deviation * deviation;
        }
        
        uint256 variance = sumSquaredDeviations / count;
        uint256 stdDev = _sqrt(variance);
        
        // Convert to confidence score (lower deviation = higher confidence)
        // Max confidence of 100 when std dev is 0, decreasing as std dev increases
        uint256 maxDeviation = average / 10; // 10% of average as maximum expected deviation
        if (stdDev >= maxDeviation) {
            return 50; // Minimum confidence
        }
        
        return 100 - (stdDev * 50) / maxDeviation;
    }
    
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
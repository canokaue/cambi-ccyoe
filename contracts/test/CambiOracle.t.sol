// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/CambiOracle.sol";
import "../src/interfaces/ICambiOracle.sol";

contract CambiOracleTest is Test {
    CambiOracle public oracle;
    
    address public governance = address(0x1);
    address public dataProvider1 = address(0x2);
    address public dataProvider2 = address(0x3);
    address public dataProvider3 = address(0x4);
    address public emergency = address(0x5);
    
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    event YieldDataSubmitted(bytes32 indexed assetId, uint256 yield, uint256 confidence, address indexed source);
    event YieldAggregated(bytes32 indexed assetId, uint256 aggregatedYield, uint256 weightedConfidence);
    event DataSourceAdded(bytes32 indexed assetId, address indexed source, uint256 weight, string name);
    event DataSourceRemoved(bytes32 indexed assetId, address indexed source);
    event EmergencyYieldSet(bytes32 indexed assetId, uint256 yield, string reason, address indexed executor);
    event CircuitBreakerTriggered(bytes32 indexed assetId, uint256 submittedYield, uint256 previousYield, string reason);

    function setUp() public {
        vm.startPrank(governance);
        oracle = new CambiOracle(governance);
        
        // Grant emergency role
        oracle.grantRole(oracle.EMERGENCY_ROLE(), emergency);
        
        // Add data sources for cmBTC
        oracle.addDataSource(CMBTC, dataProvider1, 4000, "Institutional BTC Lending");
        oracle.addDataSource(CMBTC, dataProvider2, 3000, "DeFi BTC Yields");
        oracle.addDataSource(CMBTC, dataProvider3, 3000, "Bitcoin Mining Yield");
        
        // Add data sources for cmUSD
        oracle.addDataSource(CMUSD, dataProvider1, 5000, "USD Receivables Primary");
        oracle.addDataSource(CMUSD, dataProvider2, 3000, "USD Receivables Secondary");
        oracle.addDataSource(CMUSD, dataProvider3, 2000, "USD Treasury Baseline");
        
        // Add data sources for cmBRL
        oracle.addDataSource(CMBRL, dataProvider1, 6000, "Liqi Receivables");
        oracle.addDataSource(CMBRL, dataProvider2, 2500, "B3 Government Bonds");
        oracle.addDataSource(CMBRL, dataProvider3, 1500, "Bank Credit Rates");
        
        vm.stopPrank();
    }

    function testInitialConfiguration() public {
        ICambiOracle.AssetConfig memory config = oracle.getAssetConfig(CMBTC);
        
        assertEq(config.heartbeat, 3600); // 1 hour default
        assertEq(config.deviationThreshold, 500); // 5% default
        assertEq(config.minConfidence, 8000); // 80% default
        assertTrue(config.isActive);
        assertEq(config.totalSources, 3);
    }

    function testDataSourceManagement() public {
        // Add new data source
        vm.prank(governance);
        oracle.addDataSource(CMBTC, address(0x10), 2000, "New BTC Source");
        
        ICambiOracle.AssetConfig memory config = oracle.getAssetConfig(CMBTC);
        assertEq(config.totalSources, 4);
        
        // Remove data source
        vm.prank(governance);
        oracle.removeDataSource(CMBTC, address(0x10));
        
        config = oracle.getAssetConfig(CMBTC);
        assertEq(config.totalSources, 3);
    }

    function testYieldDataSubmission() public {
        vm.expectEmit(true, false, false, true);
        emit YieldDataSubmitted(CMBTC, 500, 95, dataProvider1);
        
        vm.prank(dataProvider1);
        oracle.submitYieldData(CMBTC, 500, 95); // 5% yield, 95% confidence
        
        ICambiOracle.YieldData memory data = oracle.getLatestYieldData(CMBTC, dataProvider1);
        assertEq(data.yield, 500);
        assertEq(data.confidence, 95);
        assertEq(data.timestamp, block.timestamp);
    }

    function testUnauthorizedDataSubmission() public {
        vm.expectRevert("Unauthorized data source");
        oracle.submitYieldData(CMBTC, 500, 95); // Not a registered source
    }

    function testYieldDataAggregation() public {
        // Submit data from multiple sources
        vm.prank(dataProvider1);
        oracle.submitYieldData(CMBTC, 500, 95); // 5% yield, weight 4000
        
        vm.prank(dataProvider2);
        oracle.submitYieldData(CMBTC, 600, 90); // 6% yield, weight 3000
        
        vm.prank(dataProvider3);
        oracle.submitYieldData(CMBTC, 400, 85); // 4% yield, weight 3000
        
        // Expected weighted average: (500*4000 + 600*3000 + 400*3000) / 10000 = 500
        // Expected weighted confidence: (95*4000 + 90*3000 + 85*3000) / 10000 = 91
        
        uint256 aggregatedYield = oracle.getAssetYield(CMBTC);
        (uint256 yield, uint256 confidence) = oracle.getAssetYieldWithConfidence(CMBTC);
        
        assertEq(aggregatedYield, 500);
        assertEq(yield, 500);
        assertEq(confidence, 91);
    }

    function testCircuitBreakerActivation() public {
        // Establish baseline
        vm.prank(dataProvider1);
        oracle.submitYieldData(CMBTC, 500, 95); // 5% baseline
        
        vm.warp(block.timestamp + 100);
        
        // Submit data with large deviation (>5% threshold)
        vm.expectEmit(true, false, false, true);
        emit CircuitBreakerTriggered(CMBTC, 1000, 500, "Yield deviation exceeds threshold");
        
        vm.prank(dataProvider2);
        oracle.submitYieldData(CMBTC, 1000, 90); // 10% yield = 5% increase
        
        // Circuit breaker should be active
        assertTrue(oracle.isCircuitBreakerActive(CMBTC));
    }

    function testEmergencyYieldOverride() public {
        vm.expectEmit(true, false, false, true);
        emit EmergencyYieldSet(CMBTC, 300, "Market stress response", emergency);
        
        vm.prank(emergency);
        oracle.emergencySetYield(CMBTC, 300, "Market stress response");
        
        assertEq(oracle.getAssetYield(CMBTC), 300);
        assertTrue(oracle.isEmergencyModeActive(CMBTC));
    }

    function testStaleDataHandling() public {
        // Submit data
        vm.prank(dataProvider1);
        oracle.submitYieldData(CMBTC, 500, 95);
        
        // Fast forward beyond heartbeat
        vm.warp(block.timestamp + 7200); // 2 hours > 1 hour heartbeat
        
        // Data should be considered stale
        assertFalse(oracle.isYieldDataValid(CMBTC));
    }

    function testInsufficientConfidenceThreshold() public {
        // Submit low confidence data
        vm.prank(dataProvider1);
        oracle.submitYieldData(CMBTC, 500, 70); // Below 80% threshold
        
        vm.prank(dataProvider2);
        oracle.submitYieldData(CMBTC, 600, 75); // Below 80% threshold
        
        // Should not aggregate due to low confidence
        assertFalse(oracle.isYieldDataValid(CMBTC));
    }

    function testAccessControl() public {
        // Non-governance cannot add data sources
        vm.expectRevert();
        oracle.addDataSource(CMBTC, address(0x10), 1000, "Unauthorized");
        
        // Non-emergency cannot set emergency yield
        vm.expectRevert();
        oracle.emergencySetYield(CMBTC, 300, "Unauthorized");
    }

    function testFuzzYieldSubmission(uint256 yield, uint256 confidence) public {
        vm.assume(yield >= 0 && yield <= 10000); // 0% to 100%
        vm.assume(confidence >= 50 && confidence <= 100); // 50% to 100%
        
        vm.prank(dataProvider1);
        oracle.submitYieldData(CMBTC, yield, confidence);
        
        ICambiOracle.YieldData memory data = oracle.getLatestYieldData(CMBTC, dataProvider1);
        assertEq(data.yield, yield);
        assertEq(data.confidence, confidence);
    }
}

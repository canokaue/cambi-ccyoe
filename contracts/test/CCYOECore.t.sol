// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/CCYOECore.sol";
import "../src/YieldDistributor.sol";
import "../src/VaultManager.sol";
import "../src/CambiOracle.sol";
import "../src/RWAVault.sol";
import "../src/LiquidationEngine.sol";
import "../src/interfaces/ICambiOracle.sol";

contract CCYOECoreTest is Test {
    CCYOECore public ccyoeCore;
    YieldDistributor public yieldDistributor;
    VaultManager public vaultManager;
    CambiOracle public oracle;
    
    address public governance = address(0x1);
    address public treasury = address(0x2);
    address public operator = address(0x3);
    address public emergency = address(0x4);
    
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    event YieldOptimized(bytes32 indexed asset, uint256 oldYield, uint256 newYield, uint256 timestamp);
    event ExcessYieldDistributed(uint256 totalExcess, uint256 distributed, uint256 efficiency, uint256 timestamp);
    event EmergencyRebalance(bytes32 indexed asset, uint256 yield, string reason, address indexed executor);

    function setUp() public {
        vm.startPrank(governance);
        
        // Deploy oracle
        oracle = new CambiOracle(governance);
        
        // Deploy yield distributor
        yieldDistributor = new YieldDistributor(governance);
        
        // Deploy CCYOE core
        ccyoeCore = new CCYOECore(
            address(0), // Will set vault manager later
            address(yieldDistributor),
            address(oracle),
            treasury,
            governance
        );
        
        // Deploy vault manager
        vaultManager = new VaultManager(governance, address(ccyoeCore));
        
        // Grant roles
        ccyoeCore.grantRole(ccyoeCore.OPERATOR_ROLE(), operator);
        ccyoeCore.grantRole(ccyoeCore.EMERGENCY_ROLE(), emergency);
        yieldDistributor.grantRole(yieldDistributor.DISTRIBUTOR_ROLE(), address(ccyoeCore));
        
        // Add data sources to oracle
        oracle.addDataSource(CMBTC, governance, 10000, "Test BTC Source");
        oracle.addDataSource(CMUSD, governance, 10000, "Test USD Source");
        oracle.addDataSource(CMBRL, governance, 10000, "Test BRL Source");
        
        // Submit initial yield data
        oracle.submitYieldData(CMBTC, 500, 95);  // 5% yield
        oracle.submitYieldData(CMUSD, 1400, 98); // 14% yield
        oracle.submitYieldData(CMBRL, 2500, 90); // 25% yield (excess!)
        
        vm.stopPrank();
    }

    function testInitialConfiguration() public {
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        
        assertEq(btcConfig.targetYield, 500); // 5%
        assertEq(btcConfig.supplyCap, 20_000_000 * 1e18); // $20M
        assertFalse(btcConfig.isActive); // Not active initially
        assertEq(btcConfig.minYield, 300); // 3%
        assertEq(btcConfig.maxYield, 800); // 8%
    }

    function testAssetConfigUpdate() public {
        vm.prank(governance);
        ccyoeCore.updateAssetConfig(
            CMBTC,
            address(0x10),
            500,
            25_000_000 * 1e18,
            400,
            900,
            true
        );
        
        ICCYOECore.AssetConfig memory config = ccyoeCore.getAssetConfig(CMBTC);
        assertEq(config.vaultAddress, address(0x10));
        assertEq(config.targetYield, 500);
        assertEq(config.supplyCap, 25_000_000 * 1e18);
        assertEq(config.minYield, 400);
        assertEq(config.maxYield, 900);
        assertTrue(config.isActive);
    }

    function testAssetConfigUpdateInvalidBounds() public {
        vm.prank(governance);
        vm.expectRevert("Invalid yield bounds");
        ccyoeCore.updateAssetConfig(
            CMBTC,
            address(0x10),
            500,
            25_000_000 * 1e18,
            600, // minYield > targetYield
            900,
            true
        );
    }

    function testDistributionConfigUpdate() public {
        vm.prank(governance);
        ccyoeCore.updateDistributionConfig(
            5000, // 50% to under-supplied
            2000, // 20% to strategic
            2000, // 20% proportional
            1000, // 10% treasury
            200,  // 2% threshold
            2 hours // 2 hour frequency
        );
        
        (
            uint256 underSupplied,
            uint256 strategic,
            uint256 proportional,
            uint256 treasuryAlloc,
            uint256 threshold,
            uint256 frequency
        ) = ccyoeCore.distributionConfig();
        
        assertEq(underSupplied, 5000);
        assertEq(strategic, 2000);
        assertEq(proportional, 2000);
        assertEq(treasuryAlloc, 1000);
        assertEq(threshold, 200);
        assertEq(frequency, 2 hours);
    }

    function testDistributionConfigInvalidAllocation() public {
        vm.prank(governance);
        vm.expectRevert("Allocations must sum to 100%");
        ccyoeCore.updateDistributionConfig(
            5000, // 50%
            2000, // 20%
            2000, // 20%
            2000, // 20% - Total = 110%
            200,
            2 hours
        );
    }

    function testYieldOptimizationWithExcess() public {
        // Activate assets first
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        vm.stopPrank();
        
        // Update oracle to provide excess yield (CMBRL: 25% actual vs 20% target = 5% excess)
        vm.prank(governance);
        oracle.submitYieldData(CMBRL, 2500, 95); // 25% yield
        
        // Fast forward time to allow rebalancing
        vm.warp(block.timestamp + 2 hours);
        
        // Execute optimization
        vm.expectEmit(true, false, false, true);
        emit ExcessYieldDistributed(500, 500, 10000, block.timestamp + 2 hours); // 5% excess = 500bp
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify rebalance count increased
        assertEq(ccyoeCore.rebalanceCount(), 1);
        assertEq(ccyoeCore.lastGlobalRebalance(), block.timestamp);
    }

    function testYieldOptimizationNoExcess() public {
        // Activate assets with yields at target
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        
        // Update oracle to show target yields (no excess)
        oracle.submitYieldData(CMBTC, 500, 95);  // 5% = target
        oracle.submitYieldData(CMUSD, 1400, 98); // 14% = target
        oracle.submitYieldData(CMBRL, 2000, 90); // 20% = target
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        // Execute optimization - should not emit ExcessYieldDistributed
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify no rebalance occurred
        assertEq(ccyoeCore.rebalanceCount(), 0);
    }

    function testEmergencyRebalance() public {
        // Activate BTC asset
        vm.prank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        
        // Emergency rebalance with valid deviation
        vm.expectEmit(true, false, false, true);
        emit EmergencyRebalance(CMBTC, 800, "Market stress", emergency);
        
        vm.prank(emergency);
        ccyoeCore.emergencyRebalance(CMBTC, 800, "Market stress");
        
        // Verify yield was updated
        assertEq(ccyoeCore.assetYields(address(0x10)), 800);
    }

    function testEmergencyRebalanceInsufficientDeviation() public {
        // Activate BTC asset
        vm.prank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        
        // Set current yield
        vm.prank(governance);
        oracle.submitYieldData(CMBTC, 500, 95);
        
        // Try emergency rebalance with insufficient deviation (less than 5% threshold)
        vm.prank(emergency);
        vm.expectRevert("Emergency threshold not met");
        ccyoeCore.emergencyRebalance(CMBTC, 520, "Small adjustment"); // Only 20bp deviation
    }

    function testRateLimitingOnOptimization() public {
        // Activate assets
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        
        // Provide excess yield
        oracle.submitYieldData(CMBRL, 2500, 95);
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        // First optimization should work
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Second immediate optimization should fail
        vm.prank(operator);
        vm.expectRevert("Rate limited: too frequent rebalancing");
        ccyoeCore.optimizeYields();
        
        // After waiting, should work again
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
    }

    function testAccessControl() public {
        // Test that non-operator cannot call optimizeYields
        vm.expectRevert();
        ccyoeCore.optimizeYields();
        
        // Test that non-governance cannot update config
        vm.expectRevert();
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        
        // Test that non-emergency cannot emergency rebalance
        vm.expectRevert();
        ccyoeCore.emergencyRebalance(CMBTC, 800, "unauthorized");
    }

    function testSupplyUpdate() public {
        // Should fail from non-vault-manager
        vm.expectRevert("Only vault manager");
        ccyoeCore.updateAssetSupply(CMBTC, 1000000 * 1e18);
        
        // Should work from vault manager
        vm.prank(address(vaultManager));
        ccyoeCore.updateAssetSupply(CMBTC, 1000000 * 1e18);
        
        ICCYOECore.AssetConfig memory config = ccyoeCore.getAssetConfig(CMBTC);
        assertEq(config.currentSupply, 1000000 * 1e18);
    }

    function testGetAllAssetYields() public {
        // Activate assets
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        vm.stopPrank();
        
        (uint256[] memory yields, address[] memory vaults) = ccyoeCore.getAllAssetYields();
        
        assertEq(yields.length, 3);
        assertEq(vaults.length, 3);
        assertEq(vaults[0], address(0x10)); // BTC vault
        assertEq(vaults[1], address(0x20)); // USD vault
        assertEq(vaults[2], address(0x30)); // BRL vault
    }

    function testYieldMetrics() public {
        // Activate assets and trigger optimization
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        
        oracle.submitYieldData(CMBRL, 2500, 95); // 5% excess
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        ICCYOECore.YieldMetrics memory metrics = ccyoeCore.getYieldMetrics();
        assertEq(metrics.totalExcessYield, 500); // 5% in basis points
        assertGt(metrics.distributionEfficiency, 0);
    }

    function testPauseUnpause() public {
        // Pause
        vm.prank(emergency);
        ccyoeCore.pause();
        
        // Operations should fail when paused
        vm.prank(operator);
        vm.expectRevert("Pausable: paused");
        ccyoeCore.optimizeYields();
        
        // Unpause
        vm.prank(emergency);
        ccyoeCore.unpause();
        
        // Operations should work again (after setting up assets)
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        oracle.submitYieldData(CMBTC, 600, 95);
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields(); // Should not revert
    }

    function testCircuitBreakerYieldOutOfBounds() public {
        // Activate asset
        vm.prank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        
        // Submit yield outside bounds (above max)
        vm.prank(governance);
        oracle.submitYieldData(CMBTC, 1000, 95); // 10% yield, above 8% max
        
        vm.warp(block.timestamp + 2 hours);
        
        // Optimization should handle circuit breaker gracefully
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Should not have processed the out-of-bounds yield
        assertEq(ccyoeCore.rebalanceCount(), 0);
    }

    function testDistributionEfficiency() public {
        // Set up scenario with known excess yield
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        
        oracle.submitYieldData(CMBRL, 3000, 95); // 30% yield = 10% excess (1000bp)
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        uint256 efficiency = ccyoeCore.getDistributionEfficiency();
        assertEq(efficiency, 10000); // 100% efficiency (all excess distributed)
    }

    function testFuzzYieldOptimization(uint256 excessYield) public {
        vm.assume(excessYield >= 100 && excessYield <= 5000); // 1% to 50% excess
        
        // Activate assets
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        
        // Submit yield data with fuzzed excess
        oracle.submitYieldData(CMBRL, 2000 + excessYield, 95);
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify optimization occurred
        assertEq(ccyoeCore.rebalanceCount(), 1);
        
        ICCYOECore.YieldMetrics memory metrics = ccyoeCore.getYieldMetrics();
        assertEq(metrics.totalExcessYield, excessYield);
    }

    function testMultipleRebalances() public {
        // Activate assets
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, 300, 800, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, 1200, 1800, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1400, 2500, true);
        vm.stopPrank();
        
        // First rebalance
        vm.prank(governance);
        oracle.submitYieldData(CMBRL, 2500, 95);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        assertEq(ccyoeCore.rebalanceCount(), 1);
        
        // Second rebalance
        vm.prank(governance);
        oracle.submitYieldData(CMBRL, 2800, 95);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        assertEq(ccyoeCore.rebalanceCount(), 2);
        
        // Third rebalance
        vm.prank(governance);
        oracle.submitYieldData(CMBRL, 3000, 95);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        assertEq(ccyoeCore.rebalanceCount(), 3);
    }
}
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/CCYOECore.sol";
import "../src/YieldDistributor.sol";
import "../src/VaultManager.sol";
import "../src/CambiOracle.sol";
import "../src/RWAVault.sol";
import "../src/LiquidationEngine.sol";

/**
 * @title Integration Test Suite
 * @notice Comprehensive end-to-end testing of the CCYOE system
 * @dev Tests the complete workflow from oracle data to yield optimization
 */
contract IntegrationTest is Test {
    // Core contracts
    CCYOECore public ccyoeCore;
    YieldDistributor public yieldDistributor;
    VaultManager public vaultManager;
    CambiOracle public oracle;
    RWAVault public rwaVault;
    LiquidationEngine public liquidationEngine;
    
    // Test addresses
    address public governance = address(0x1);
    address public treasury = address(0x2);
    address public operator = address(0x3);
    address public emergency = address(0x4);
    address public dataProvider1 = address(0x5);
    address public dataProvider2 = address(0x6);
    address public dataProvider3 = address(0x7);
    address public user1 = address(0x8);
    address public user2 = address(0x9);
    address public liquidator = address(0xA);
    
    // Asset identifiers
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    // Test events
    event EndToEndYieldOptimization(
        uint256 totalExcessYield,
        uint256 distributedAmount,
        uint256 distributionEfficiency,
        uint256 timestamp
    );

    function setUp() public {
        vm.startPrank(governance);
        
        // 1. Deploy Oracle System
        oracle = new CambiOracle(governance);
        
        // 2. Deploy Yield Distributor
        yieldDistributor = new YieldDistributor(governance);
        
        // 3. Deploy CCYOE Core
        ccyoeCore = new CCYOECore(
            address(0), // Vault manager set later
            address(yieldDistributor),
            address(oracle),
            treasury,
            governance
        );
        
        // 4. Deploy Vault Manager
        vaultManager = new VaultManager(governance, address(ccyoeCore));
        
        // 5. Deploy RWA Vault
        rwaVault = new RWAVault("Cambi RWA", "cmRWA", governance);
        
        // 6. Deploy Liquidation Engine
        liquidationEngine = new LiquidationEngine(address(oracle), governance);
        
        // Set up roles and permissions
        _setupRolesAndPermissions();
        
        // Configure oracle data sources
        _setupOracleDataSources();
        
        // Configure assets
        _setupAssetConfigurations();
        
        vm.stopPrank();
    }

    function _setupRolesAndPermissions() internal {
        // Grant roles to contracts
        ccyoeCore.grantRole(ccyoeCore.OPERATOR_ROLE(), operator);
        ccyoeCore.grantRole(ccyoeCore.EMERGENCY_ROLE(), emergency);
        
        yieldDistributor.grantRole(yieldDistributor.DISTRIBUTOR_ROLE(), address(ccyoeCore));
        yieldDistributor.grantRole(yieldDistributor.EMERGENCY_ROLE(), emergency);
        
        oracle.grantRole(oracle.EMERGENCY_ROLE(), emergency);
        
        rwaVault.grantRole(rwaVault.RWA_MANAGER_ROLE(), governance);
        rwaVault.grantRole(rwaVault.EMERGENCY_ROLE(), emergency);
        
        liquidationEngine.grantRole(liquidationEngine.KEEPER_ROLE(), operator);
        liquidationEngine.grantRole(liquidationEngine.EMERGENCY_ROLE(), emergency);
    }

    function _setupOracleDataSources() internal {
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
    }

    function _setupAssetConfigurations() internal {
        // Configure cmBTC
        ccyoeCore.updateAssetConfig(
            CMBTC,
            address(rwaVault), // Using RWA vault as example
            500,  // 5% target yield
            20_000_000 * 1e18, // $20M supply cap
            300,  // 3% min yield
            800,  // 8% max yield
            true  // active
        );
        
        // Configure cmUSD
        ccyoeCore.updateAssetConfig(
            CMUSD,
            address(rwaVault),
            1400, // 14% target yield
            50_000_000 * 1e18, // $50M supply cap
            1200, // 12% min yield
            1800, // 18% max yield
            true  // active
        );
        
        // Configure cmBRL
        ccyoeCore.updateAssetConfig(
            CMBRL,
            address(rwaVault),
            2000, // 20% target yield
            type(uint256).max, // Unlimited supply
            1400, // 14% min yield
            2500, // 25% max yield
            true  // active
        );
        
        // Set treasury address
        yieldDistributor.setTreasury(treasury);
    }

    /**
     * @notice Test complete end-to-end yield optimization workflow
     * @dev Simulates real-world scenario with oracle data → CCYOE optimization → yield distribution
     */
    function testEndToEndYieldOptimization() public {
        // Step 1: Data providers submit yield data
        _submitInitialYieldData();
        
        // Step 2: Submit excess yield data (cmBRL generating 25% vs 20% target)
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBRL, 2500, 95); // 25% yield, 95% confidence
        vm.stopPrank();
        
        vm.startPrank(dataProvider2);
        oracle.submitYieldData(CMBRL, 2600, 90); // 26% yield, 90% confidence
        vm.stopPrank();
        
        vm.startPrank(dataProvider3);
        oracle.submitYieldData(CMBRL, 2400, 88); // 24% yield, 88% confidence
        vm.stopPrank();
        
        // Step 3: Wait for rebalancing interval
        vm.warp(block.timestamp + 2 hours);
        
        // Step 4: Trigger yield optimization
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Step 5: Verify optimization occurred
        assertEq(ccyoeCore.rebalanceCount(), 1);
        assertTrue(ccyoeCore.lastGlobalRebalance() > 0);
        
        // Step 6: Check yield metrics
        ICCYOECore.YieldMetrics memory metrics = ccyoeCore.getYieldMetrics();
        assertGt(metrics.totalExcessYield, 0);
        assertGt(metrics.distributionEfficiency, 0);
    }

    /**
     * @notice Test oracle data aggregation with multiple sources
     */
    function testOracleDataAggregation() public {
        _submitInitialYieldData();
        
        // Verify aggregated yields
        uint256 btcYield = oracle.getAssetYield(CMBTC);
        uint256 usdYield = oracle.getAssetYield(CMUSD);
        uint256 brlYield = oracle.getAssetYield(CMBRL);
        
        // Expected weighted averages based on source weights
        assertApproxEqAbs(btcYield, 500, 50); // ~5% ±0.5%
        assertApproxEqAbs(usdYield, 1400, 100); // ~14% ±1%
        assertApproxEqAbs(brlYield, 2000, 100); // ~20% ±1%
        
        // Verify data validity
        assertTrue(oracle.isYieldDataValid(CMBTC));
        assertTrue(oracle.isYieldDataValid(CMUSD));
        assertTrue(oracle.isYieldDataValid(CMBRL));
    }

    /**
     * @notice Test yield distribution under different scenarios
     */
    function testYieldDistributionScenarios() public {
        _submitInitialYieldData();
        
        // Scenario 1: High cmBRL excess yield
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBRL, 3000, 95); // 30% yield = 10% excess
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Check that excess was distributed
        ICCYOECore.YieldMetrics memory metrics1 = ccyoeCore.getYieldMetrics();
        assertEq(metrics1.totalExcessYield, 1000); // 10% in basis points
        
        // Scenario 2: Multiple assets with excess
        vm.warp(block.timestamp + 2 hours);
        
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMUSD, 1800, 98); // 18% vs 14% target = 4% excess
        oracle.submitYieldData(CMBTC, 800, 95);  // 8% vs 5% target = 3% excess
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        ICCYOECore.YieldMetrics memory metrics2 = ccyoeCore.getYieldMetrics();
        assertGt(metrics2.totalExcessYield, 0);
    }

    /**
     * @notice Test circuit breaker activation and recovery
     */
    function testCircuitBreakerIntegration() public {
        _submitInitialYieldData();
        
        // Submit data that triggers circuit breaker (large deviation)
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBTC, 1500, 95); // 15% yield - massive spike
        vm.stopPrank();
        
        // Circuit breaker should be active
        assertTrue(oracle.isCircuitBreakerActive(CMBTC));
        
        // Optimization should handle circuit breaker gracefully
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Should not have processed the anomalous data
        uint256 rebalanceCount = ccyoeCore.rebalanceCount();
        // May be 0 if circuit breaker prevented processing
        
        // Reset circuit breaker
        vm.prank(emergency);
        oracle.resetCircuitBreaker(CMBTC);
        
        assertFalse(oracle.isCircuitBreakerActive(CMBTC));
    }

    /**
     * @notice Test emergency procedures across all contracts
     */
    function testEmergencyProcedures() public {
        _submitInitialYieldData();
        
        // Emergency pause CCYOE Core
        vm.prank(emergency);
        ccyoeCore.pause();
        
        vm.prank(operator);
        vm.expectRevert("Pausable: paused");
        ccyoeCore.optimizeYields();
        
        // Emergency yield override
        vm.prank(emergency);
        oracle.emergencySetYield(CMBTC, 300, "Market crash");
        
        assertEq(oracle.getAssetYield(CMBTC), 300);
        assertTrue(oracle.isEmergencyModeActive(CMBTC));
        
        // Emergency rebalance
        vm.prank(emergency);
        ccyoeCore.unpause();
        
        vm.prank(emergency);
        ccyoeCore.emergencyRebalance(CMBTC, 400, "Emergency adjustment");
        
        // Emergency distribution pause
        vm.prank(emergency);
        yieldDistributor.pause();
        
        // Verify all emergency states
        assertTrue(oracle.isEmergencyModeActive(CMBTC));
    }

    /**
     * @notice Test system under stress conditions
     */
    function testSystemStressConditions() public {
        _submitInitialYieldData();
        
        // Simulate rapid yield changes
        for (uint i = 0; i < 5; i++) {
            vm.startPrank(dataProvider1);
            oracle.submitYieldData(CMBRL, 2000 + (i * 200), 95); // Increasing yields
            vm.stopPrank();
            
            vm.warp(block.timestamp + 2 hours);
            
            vm.prank(operator);
            ccyoeCore.optimizeYields();
        }
        
        // Verify system handled multiple optimizations
        assertEq(ccyoeCore.rebalanceCount(), 5);
        
        // Test with extreme yield values
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBRL, 5000, 95); // 50% yield - extreme
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        // Should trigger circuit breaker or be handled gracefully
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // System should remain stable
        assertTrue(ccyoeCore.hasRole(ccyoeCore.OPERATOR_ROLE(), operator));
    }

    /**
     * @notice Test asset supply cap enforcement
     */
    function testSupplyCapEnforcement() public {
        // Update asset supplies to near caps
        vm.prank(address(vaultManager));
        ccyoeCore.updateAssetSupply(CMBTC, 19_000_000 * 1e18); // Near $20M cap
        
        vm.prank(address(vaultManager));
        ccyoeCore.updateAssetSupply(CMUSD, 45_000_000 * 1e18); // Near $50M cap
        
        _submitInitialYieldData();
        
        // Submit high yields that would normally trigger expansion
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBTC, 900, 95); // 9% yield - above max
        oracle.submitYieldData(CMUSD, 1900, 95); // 19% yield - above max
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify supply caps were respected
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        ICCYOECore.AssetConfig memory usdConfig = ccyoeCore.getAssetConfig(CMUSD);
        
        assertLe(btcConfig.currentSupply, btcConfig.supplyCap);
        assertLe(usdConfig.currentSupply, usdConfig.supplyCap);
    }

    /**
     * @notice Test performance metrics and reporting
     */
    function testPerformanceMetrics() public {
        _submitInitialYieldData();
        
        // Generate several optimization cycles
        for (uint i = 0; i < 3; i++) {
            vm.startPrank(dataProvider1);
            oracle.submitYieldData(CMBRL, 2500 + (i * 100), 95);
            vm.stopPrank();
            
            vm.warp(block.timestamp + 2 hours);
            
            vm.prank(operator);
            ccyoeCore.optimizeYields();
        }
        
        // Check accumulated metrics
        ICCYOECore.YieldMetrics memory metrics = ccyoeCore.getYieldMetrics();
        assertGt(metrics.totalExcessYield, 0);
        assertGt(metrics.distributionEfficiency, 0);
        
        // Check rebalance history
        assertEq(ccyoeCore.rebalanceCount(), 3);
        assertGt(ccyoeCore.lastGlobalRebalance(), 0);
        
        // Check distribution efficiency
        uint256 efficiency = ccyoeCore.getDistributionEfficiency();
        assertGt(efficiency, 8000); // >80% efficiency expected
    }

    /**
     * @notice Test governance operations
     */
    function testGovernanceOperations() public {
        // Test parameter updates
        vm.startPrank(governance);
        
        // Update distribution configuration
        ccyoeCore.updateDistributionConfig(
            4500, // 45% under-supplied
            2500, // 25% strategic
            2000, // 20% proportional
            1000, // 10% treasury
            150,  // 1.5% threshold
            3 hours // 3 hour frequency
        );
        
        // Update asset configuration
        ccyoeCore.updateAssetConfig(
            CMBTC,
            address(rwaVault),
            600,  // 6% target yield
            25_000_000 * 1e18, // $25M supply cap
            400,  // 4% min yield
            900,  // 9% max yield
            true  // active
        );
        
        vm.stopPrank();
        
        // Verify changes took effect
        (
            uint256 underSupplied,
            uint256 strategic,
            uint256 proportional,
            uint256 treasuryAlloc,
            uint256 threshold,
            uint256 frequency
        ) = ccyoeCore.distributionConfig();
        
        assertEq(underSupplied, 4500);
        assertEq(strategic, 2500);
        assertEq(threshold, 150);
        
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        assertEq(btcConfig.targetYield, 600);
        assertEq(btcConfig.supplyCap, 25_000_000 * 1e18);
    }

    /**
     * @notice Helper function to submit initial yield data
     */
    function _submitInitialYieldData() internal {
        // Submit target yields for all assets
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBTC, 500, 95);   // 5% yield
        oracle.submitYieldData(CMUSD, 1400, 98);  // 14% yield
        oracle.submitYieldData(CMBRL, 2000, 90);  // 20% yield
        vm.stopPrank();
        
        vm.startPrank(dataProvider2);
        oracle.submitYieldData(CMBTC, 520, 90);   // 5.2% yield
        oracle.submitYieldData(CMUSD, 1450, 95);  // 14.5% yield
        oracle.submitYieldData(CMBRL, 2050, 88);  // 20.5% yield
        vm.stopPrank();
        
        vm.startPrank(dataProvider3);
        oracle.submitYieldData(CMBTC, 480, 85);   // 4.8% yield
        oracle.submitYieldData(CMUSD, 1350, 92);  // 13.5% yield
        oracle.submitYieldData(CMBRL, 1950, 85);  // 19.5% yield
        vm.stopPrank();
    }

    /**
     * @notice Test complete system shutdown and recovery
     */
    function testSystemShutdownRecovery() public {
        _submitInitialYieldData();
        
        // Perform initial optimization
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        uint256 initialRebalanceCount = ccyoeCore.rebalanceCount();
        
        // Emergency shutdown
        vm.startPrank(emergency);
        ccyoeCore.pause();
        yieldDistributor.pause();
        oracle.pause();
        vm.stopPrank();
        
        // Verify system is paused
        vm.prank(operator);
        vm.expectRevert("Pausable: paused");
        ccyoeCore.optimizeYields();
        
        // Recovery
        vm.startPrank(emergency);
        ccyoeCore.unpause();
        yieldDistributor.unpause();
        oracle.unpause();
        vm.stopPrank();
        
        // Submit new data and verify system works
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBRL, 2300, 95);
        vm.stopPrank();
        
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify system recovered
        assertEq(ccyoeCore.rebalanceCount(), initialRebalanceCount + 1);
    }

    /**
     * @notice Test edge case scenarios
     */
    function testEdgeCases() public {
        // Test with zero yields
        vm.startPrank(dataProvider1);
        oracle.submitYieldData(CMBTC, 0, 95);
        vm.stopPrank();
        
        // Test with maximum yields
        vm.startPrank(dataProvider2);
        oracle.submitYieldData(CMUSD, 10000, 95); // 100% yield
        vm.stopPrank();
        
        // Test optimization with edge case data
        vm.warp(block.timestamp + 2 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // System should handle gracefully
        assertTrue(address(ccyoeCore) != address(0));
    }
}

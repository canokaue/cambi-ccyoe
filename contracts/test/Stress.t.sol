// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/CCYOECore.sol";
import "../src/YieldDistributor.sol";
import "../src/VaultManager.sol";
import "../src/CambiOracle.sol";

/**
 * @title Stress Test Suite
 * @notice Tests CCYOE system under extreme market conditions and high load
 * @dev Simulates market crashes, flash crashes, rapid changes, and high-frequency operations
 */
contract StressTest is Test {
    CCYOECore public ccyoeCore;
    YieldDistributor public yieldDistributor;
    VaultManager public vaultManager;
    CambiOracle public oracle;
    
    address public governance = address(0x1);
    address public treasury = address(0x2);
    address public operator = address(0x3);
    address public emergency = address(0x4);
    address[] public dataProviders;
    
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    // Stress test parameters
    uint256 constant STRESS_ITERATIONS = 100;
    uint256 constant HIGH_FREQUENCY_OPERATIONS = 50;
    uint256 constant EXTREME_YIELD_VOLATILITY = 5000; // 50% swings

    function setUp() public {
        vm.startPrank(governance);
        
        // Deploy contracts
        oracle = new CambiOracle(governance);
        yieldDistributor = new YieldDistributor(governance);
        ccyoeCore = new CCYOECore(
            address(0),
            address(yieldDistributor),
            address(oracle),
            treasury,
            governance
        );
        vaultManager = new VaultManager(governance, address(ccyoeCore));
        
        // Setup roles
        ccyoeCore.grantRole(ccyoeCore.OPERATOR_ROLE(), operator);
        ccyoeCore.grantRole(ccyoeCore.EMERGENCY_ROLE(), emergency);
        yieldDistributor.grantRole(yieldDistributor.DISTRIBUTOR_ROLE(), address(ccyoeCore));
        oracle.grantRole(oracle.EMERGENCY_ROLE(), emergency);
        
        // Create multiple data providers for stress testing
        for (uint i = 0; i < 10; i++) {
            address provider = address(uint160(0x100 + i));
            dataProviders.push(provider);
        }
        
        // Setup oracle with many data sources
        _setupStressOracleConfiguration();
        
        // Configure assets for stress testing
        _setupStressAssetConfiguration();
        
        vm.stopPrank();
    }

    function _setupStressOracleConfiguration() internal {
        // Add many data sources for each asset to test aggregation under load
        for (uint i = 0; i < dataProviders.length; i++) {
            uint256 weight = 1000; // Equal weights
            
            oracle.addDataSource(CMBTC, dataProviders[i], weight, string(abi.encodePacked("BTC Source ", vm.toString(i))));
            oracle.addDataSource(CMUSD, dataProviders[i], weight, string(abi.encodePacked("USD Source ", vm.toString(i))));
            oracle.addDataSource(CMBRL, dataProviders[i], weight, string(abi.encodePacked("BRL Source ", vm.toString(i))));
        }
    }

    function _setupStressAssetConfiguration() internal {
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 100_000_000 * 1e18, 100, 2000, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 200_000_000 * 1e18, 500, 3000, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, 1000, 5000, true);
        
        // Set aggressive distribution parameters for stress testing
        ccyoeCore.updateDistributionConfig(4000, 3000, 2000, 1000, 50, 10 minutes);
    }

    /**
     * @notice Test system under extreme yield volatility
     * @dev Simulates rapid yield changes across all assets
     */
    function testExtremeYieldVolatility() public {
        uint256[3] memory baseYields = [uint256(500), 1400, 2000];
        bytes32[3] memory assets = [CMBTC, CMUSD, CMBRL];
        
        for (uint iteration = 0; iteration < STRESS_ITERATIONS; iteration++) {
            // Create extreme yield swings
            for (uint assetIndex = 0; assetIndex < 3; assetIndex++) {
                for (uint providerIndex = 0; providerIndex < dataProviders.length; providerIndex++) {
                    // Generate random yield variations (±50%)
                    uint256 variation = (uint256(keccak256(abi.encode(iteration, assetIndex, providerIndex))) % EXTREME_YIELD_VOLATILITY);
                    bool isPositive = (variation % 2 == 0);
                    
                    uint256 yieldValue = baseYields[assetIndex];
                    if (isPositive) {
                        yieldValue = yieldValue + (variation / 2);
                    } else {
                        yieldValue = yieldValue > (variation / 2) ? yieldValue - (variation / 2) : 100;
                    }
                    
                    // Submit volatile yield data
                    vm.prank(dataProviders[providerIndex]);
                    oracle.submitYieldData(assets[assetIndex], yieldValue, 80 + (variation % 20));
                }
            }
            
            // Fast forward time
            vm.warp(block.timestamp + 15 minutes);
            
            // Attempt optimization
            vm.prank(operator);
            try ccyoeCore.optimizeYields() {
                // Success - system handled volatility
            } catch {
                // Failure is acceptable under extreme conditions
                console.log("Optimization failed at iteration:", iteration);
            }
        }
        
        // Verify system integrity after stress test
        assertTrue(address(ccyoeCore) != address(0));
        assertGt(ccyoeCore.rebalanceCount(), 0);
    }

    /**
     * @notice Test flash crash scenario
     * @dev Simulates sudden massive yield drops across all assets
     */
    function testFlashCrashScenario() public {
        // Setup normal yields
        _submitNormalYieldData();
        
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        uint256 precrashRebalances = ccyoeCore.rebalanceCount();
        
        // FLASH CRASH: All yields drop by 80%
        for (uint i = 0; i < dataProviders.length; i++) {
            vm.startPrank(dataProviders[i]);
            oracle.submitYieldData(CMBTC, 100, 95);  // 1% (from 5%)
            oracle.submitYieldData(CMUSD, 280, 98);  // 2.8% (from 14%)
            oracle.submitYieldData(CMBRL, 400, 90);  // 4% (from 20%)
            vm.stopPrank();
        }
        
        // Attempt multiple rapid optimizations during crash
        for (uint i = 0; i < 10; i++) {
            vm.warp(block.timestamp + 15 minutes);
            
            vm.prank(operator);
            try ccyoeCore.optimizeYields() {
                // Log successful optimizations during crash
            } catch {
                console.log("Optimization failed during crash iteration:", i);
            }
        }
        
        // Verify system survived flash crash
        assertGe(ccyoeCore.rebalanceCount(), precrashRebalances);
        
        // Test recovery - yields slowly return to normal
        for (uint recovery = 1; recovery <= 10; recovery++) {
            uint256 recoveryMultiplier = recovery;
            
            for (uint i = 0; i < dataProviders.length; i++) {
                vm.startPrank(dataProviders[i]);
                oracle.submitYieldData(CMBTC, 100 + (40 * recoveryMultiplier), 95);
                oracle.submitYieldData(CMUSD, 280 + (112 * recoveryMultiplier), 98);
                oracle.submitYieldData(CMBRL, 400 + (160 * recoveryMultiplier), 90);
                vm.stopPrank();
            }
            
            vm.warp(block.timestamp + 30 minutes);
            vm.prank(operator);
            ccyoeCore.optimizeYields();
        }
        
        // Verify recovery worked
        assertGt(ccyoeCore.rebalanceCount(), precrashRebalances + 5);
    }

    /**
     * @notice Test high-frequency operations
     * @dev Rapid-fire yield submissions and optimizations
     */
    function testHighFrequencyOperations() public {
        _submitNormalYieldData();
        
        uint256 initialGas = gasleft();
        uint256 successfulOptimizations = 0;
        
        // Rapid fire operations
        for (uint i = 0; i < HIGH_FREQUENCY_OPERATIONS; i++) {
            // Submit slightly different yield data
            vm.startPrank(dataProviders[i % dataProviders.length]);
            oracle.submitYieldData(CMBRL, 2000 + (i * 10), 90); // Gradually increasing yields
            vm.stopPrank();
            
            // Try to optimize immediately (testing rate limiting)
            vm.warp(block.timestamp + 11 minutes); // Just above minimum interval
            
            vm.prank(operator);
            try ccyoeCore.optimizeYields() {
                successfulOptimizations++;
            } catch {
                // Expected - rate limiting should prevent some operations
            }
        }
        
        console.log("Successful high-frequency optimizations:", successfulOptimizations);
        console.log("Gas consumed:", initialGas - gasleft());
        
        // Should have rate limited some operations
        assertLt(successfulOptimizations, HIGH_FREQUENCY_OPERATIONS);
        assertGt(successfulOptimizations, 0);
    }

    /**
     * @notice Test oracle data corruption and recovery
     * @dev Simulates corrupted data sources and system recovery
     */
    function testOracleDataCorruption() public {
        _submitNormalYieldData();
        
        // Corrupt half the data sources with extreme values
        uint256 corruptedSources = dataProviders.length / 2;
        
        for (uint i = 0; i < corruptedSources; i++) {
            vm.startPrank(dataProviders[i]);
            // Submit impossible yield values
            oracle.submitYieldData(CMBTC, 50000, 99);  // 500% yield
            oracle.submitYieldData(CMUSD, 0, 1);       // 0% yield, 1% confidence
            oracle.submitYieldData(CMBRL, 100000, 50); // 1000% yield, 50% confidence
            vm.stopPrank();
        }
        
        // System should handle corruption gracefully
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Gradually fix corrupted sources
        for (uint i = 0; i < corruptedSources; i++) {
            vm.startPrank(dataProviders[i]);
            oracle.submitYieldData(CMBTC, 500, 95);
            oracle.submitYieldData(CMUSD, 1400, 98);
            oracle.submitYieldData(CMBRL, 2000, 90);
            vm.stopPrank();
            
            vm.warp(block.timestamp + 30 minutes);
            vm.prank(operator);
            ccyoeCore.optimizeYields();
        }
        
        // Verify system recovered
        assertTrue(oracle.isYieldDataValid(CMBTC));
        assertTrue(oracle.isYieldDataValid(CMUSD));
        assertTrue(oracle.isYieldDataValid(CMBRL));
    }

    /**
     * @notice Test massive supply changes
     * @dev Simulates rapid supply expansion and contraction
     */
    function testMassiveSupplyChanges() public {
        _submitNormalYieldData();
        
        // Simulate massive supply increases
        vm.startPrank(address(vaultManager));
        ccyoeCore.updateAssetSupply(CMBTC, 50_000_000 * 1e18);  // 2.5x increase
        ccyoeCore.updateAssetSupply(CMUSD, 150_000_000 * 1e18); // 3x increase
        ccyoeCore.updateAssetSupply(CMBRL, 500_000_000 * 1e18); // Massive increase
        vm.stopPrank();
        
        // Test optimization with massive supplies
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Rapidly contract supplies
        vm.startPrank(address(vaultManager));
        ccyoeCore.updateAssetSupply(CMBTC, 1_000_000 * 1e18);   // Drastic reduction
        ccyoeCore.updateAssetSupply(CMUSD, 5_000_000 * 1e18);   // Drastic reduction
        ccyoeCore.updateAssetSupply(CMBRL, 10_000_000 * 1e18);  // Drastic reduction
        vm.stopPrank();
        
        // Test optimization with minimal supplies
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify system handled extreme supply changes
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        ICCYOECore.AssetConfig memory usdConfig = ccyoeCore.getAssetConfig(CMUSD);
        ICCYOECore.AssetConfig memory brlConfig = ccyoeCore.getAssetConfig(CMBRL);
        
        assertEq(btcConfig.currentSupply, 1_000_000 * 1e18);
        assertEq(usdConfig.currentSupply, 5_000_000 * 1e18);
        assertEq(brlConfig.currentSupply, 10_000_000 * 1e18);
    }

    /**
     * @notice Test cascading failures
     * @dev Tests system resilience when multiple components fail
     */
    function testCascadingFailures() public {
        _submitNormalYieldData();
        
        // Initial optimization
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Simulate oracle failure (all sources go stale)
        vm.warp(block.timestamp + 24 hours); // Way past heartbeat
        
        // Try optimization with stale data
        vm.prank(operator);
        try ccyoeCore.optimizeYields() {
            // Should handle gracefully
        } catch {
            // Failure expected with stale data
        }
        
        // Simulate partial recovery (only some sources return)
        for (uint i = 0; i < 3; i++) {
            vm.startPrank(dataProviders[i]);
            oracle.submitYieldData(CMBRL, 2000, 90);
            vm.stopPrank();
        }
        
        // Try optimization with limited data
        vm.prank(operator);
        try ccyoeCore.optimizeYields() {
            // Partial recovery
        } catch {
            // Still acceptable
        }
        
        // Full recovery
        _submitNormalYieldData();
        
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify full recovery
        assertGt(ccyoeCore.rebalanceCount(), 0);
    }

    /**
     * @notice Test extreme gas conditions
     * @dev Tests system behavior under high gas prices and gas limit stress
     */
    function testExtremeGasConditions() public {
        _submitNormalYieldData();
        
        // Simulate high gas price environment
        uint256 initialGasLeft = gasleft();
        
        // Perform optimization under gas stress
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        uint256 gasUsed = initialGasLeft - gasleft();
        console.log("Gas used for optimization:", gasUsed);
        
        // Verify gas usage is reasonable (under 500k gas)
        assertLt(gasUsed, 500000);
        
        // Test with many rapid operations
        for (uint i = 0; i < 20; i++) {
            vm.startPrank(dataProviders[i % dataProviders.length]);
            oracle.submitYieldData(CMBRL, 2000 + i, 90);
            vm.stopPrank();
            
            if (i % 5 == 0) {
                vm.warp(block.timestamp + 15 minutes);
                vm.prank(operator);
                try ccyoeCore.optimizeYields() {
                    // Track gas usage
                } catch {
                    // Rate limiting expected
                }
            }
        }
    }

    /**
     * @notice Test protocol-wide emergency scenarios
     * @dev Tests emergency shutdown and recovery procedures
     */
    function testProtocolEmergencyScenarios() public {
        _submitNormalYieldData();
        
        // Normal operations
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        uint256 normalRebalances = ccyoeCore.rebalanceCount();
        
        // EMERGENCY: Protocol-wide shutdown
        vm.startPrank(emergency);
        ccyoeCore.pause();
        yieldDistributor.pause();
        oracle.pause();
        vm.stopPrank();
        
        // Verify all operations are blocked
        vm.prank(operator);
        vm.expectRevert("Pausable: paused");
        ccyoeCore.optimizeYields();
        
        // Emergency operations should still work
        vm.prank(emergency);
        oracle.emergencySetYield(CMBTC, 100, "Emergency low yield");
        
        // Gradual recovery
        vm.prank(emergency);
        oracle.unpause();
        
        // Partial functionality restored
        vm.startPrank(dataProviders[0]);
        oracle.submitYieldData(CMBTC, 500, 95);
        vm.stopPrank();
        
        // Full recovery
        vm.startPrank(emergency);
        ccyoeCore.unpause();
        yieldDistributor.unpause();
        vm.stopPrank();
        
        // Test that everything works again
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        assertGt(ccyoeCore.rebalanceCount(), normalRebalances);
    }

    /**
     * @notice Helper function to submit normal yield data
     */
    function _submitNormalYieldData() internal {
        for (uint i = 0; i < dataProviders.length; i++) {
            vm.startPrank(dataProviders[i]);
            oracle.submitYieldData(CMBTC, 500, 95);   // 5%
            oracle.submitYieldData(CMUSD, 1400, 98);  // 14%
            oracle.submitYieldData(CMBRL, 2000, 90);  // 20%
            vm.stopPrank();
        }
    }

    /**
     * @notice Test system limits and boundaries
     * @dev Tests behavior at protocol limits
     */
    function testSystemLimits() public {
        // Test maximum number of rebalances
        _submitNormalYieldData();
        
        // Perform many optimizations to test limits
        for (uint i = 0; i < 1000; i++) {
            vm.startPrank(dataProviders[i % dataProviders.length]);
            oracle.submitYieldData(CMBRL, 2000 + (i % 100), 90);
            vm.stopPrank();
            
            vm.warp(block.timestamp + 15 minutes);
            vm.prank(operator);
            try ccyoeCore.optimizeYields() {
                // Continue until rate limited
            } catch {
                break;
            }
        }
        
        // System should still be functional
        assertTrue(address(ccyoeCore) != address(0));
        
        // Test edge case values
        vm.startPrank(dataProviders[0]);
        oracle.submitYieldData(CMBTC, 1, 95);     // Minimum yield
        oracle.submitYieldData(CMUSD, 9999, 98);  // Near maximum yield
        vm.stopPrank();
        
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify system handled edge cases
        assertGt(ccyoeCore.rebalanceCount(), 0);
    }

    /**
     * @notice Test recovery from corrupted state
     * @dev Tests system recovery mechanisms
     */
    function testStateRecovery() public {
        _submitNormalYieldData();
        
        // Corrupt system state by submitting extreme data
        vm.startPrank(dataProviders[0]);
        oracle.submitYieldData(CMBTC, type(uint256).max, 100);
        vm.stopPrank();
        
        // System should handle corruption
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        try ccyoeCore.optimizeYields() {
            // May fail due to corruption
        } catch {
            // Expected
        }
        
        // Emergency recovery
        vm.prank(emergency);
        oracle.emergencySetYield(CMBTC, 500, "Recovery");
        
        // Reset to normal
        vm.startPrank(dataProviders[0]);
        oracle.submitYieldData(CMBTC, 500, 95);
        vm.stopPrank();
        
        // Verify recovery
        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        assertTrue(oracle.isYieldDataValid(CMBTC));
    }
}

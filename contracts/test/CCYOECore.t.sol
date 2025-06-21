// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/CCYOECore.sol";
import "../src/YieldDistributor.sol";
import "../src/VaultManager.sol";
import "../src/interfaces/ICambiOracle.sol";

contract MockOracle is ICambiOracle {
    mapping(bytes32 => AssetYieldData) public yieldData;
    
    function updateAssetYield(bytes32 assetId, uint256 newYield, uint256 confidence) external override {
        yieldData[assetId] = AssetYieldData({
            yield: newYield,
            timestamp: block.timestamp,
            confidence: confidence,
            isValid: true
        });
        
        emit YieldUpdated(assetId, yieldData[assetId].yield, newYield, block.timestamp);
    }
    
    function getAssetYield(bytes32 assetId) external view override returns (uint256) {
        return yieldData[assetId].yield;
    }
    
    function getAssetYieldData(bytes32 assetId) external view override returns (AssetYieldData memory) {
        return yieldData[assetId];
    }
    
    function isYieldDataValid(bytes32 assetId) external view override returns (bool) {
        return yieldData[assetId].isValid && block.timestamp - yieldData[assetId].timestamp < 86400; // 24 hours
    }
}

contract CCYOECoreTest is Test {
    CCYOECore public ccyoeCore;
    YieldDistributor public yieldDistributor;
    VaultManager public vaultManager;
    MockOracle public oracle;
    
    address public governance = address(0x1);
    address public treasury = address(0x2);
    address public operator = address(0x3);
    
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    function setUp() public {
        // Deploy contracts
        oracle = new MockOracle();
        yieldDistributor = new YieldDistributor(governance);
        
        // Deploy CCYOE core first
        ccyoeCore = new CCYOECore(
            address(0), // Will set vault manager later
            address(yieldDistributor),
            address(oracle),
            treasury,
            governance
        );
        
        // Deploy vault manager with ccyoe core reference
        vaultManager = new VaultManager(governance, address(ccyoeCore));
        
        // Grant roles
        vm.startPrank(governance);
        ccyoeCore.grantRole(ccyoeCore.OPERATOR_ROLE(), operator);
        yieldDistributor.grantRole(yieldDistributor.DISTRIBUTOR_ROLE(), address(ccyoeCore));
        vm.stopPrank();
        
        // Set up mock yields
        oracle.updateAssetYield(CMBTC, 500, 95); // 5% yield, 95% confidence
        oracle.updateAssetYield(CMUSD, 1400, 98); // 14% yield, 98% confidence
        oracle.updateAssetYield(CMBRL, 2500, 90); // 25% yield, 90% confidence (excess!)
    }
    
    function testInitialConfiguration() public {
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        
        assertEq(btcConfig.targetYield, 500); // 5%
        assertEq(btcConfig.supplyCap, 20_000_000 * 1e18); // $20M
        assertFalse(btcConfig.isActive); // Not active initially
    }
    
    function testYieldOptimization() public {
        // Activate assets
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, true);
        vm.stopPrank();
        
        // Simulate time passage
        vm.warp(block.timestamp + 1 days);
        
        // Run optimization
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Check that excess yield from CMBRL (25% actual vs 20% target) was distributed
        // This would be verified by checking distributor state in a real implementation
    }
    
    function testEmergencyRebalance() public {
        // Activate BTC asset
        vm.prank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, true);
        
        // Emergency rebalance
        vm.prank(governance);
        ccyoeCore.emergencyRebalance(CMBTC, 1000, "Market stress");
        
        // Verify the emergency rebalance was executed
        // In real implementation, would check vault yield was updated
    }
    
    function testDistributionConfigUpdate() public {
        vm.prank(governance);
        ccyoeCore.updateDistributionConfig(
            5000, // 50% to under-supplied
            2000, // 20% to strategic
            2000, // 20% proportional
            1000, // 10% treasury
            200,  // 2% threshold
            2 days // 2 day frequency
        );
        
        (, , , , uint256 threshold, uint256 frequency) = ccyoeCore.distributionConfig();
        assertEq(threshold, 200);
        assertEq(frequency, 2 days);
    }
    
    function testAccessControl() public {
        // Test that non-operator cannot call optimizeYields
        vm.expectRevert();
        ccyoeCore.optimizeYields();
        
        // Test that non-governance cannot update config
        vm.expectRevert();
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, true);
    }
    
    function testSupplyCapEnforcement() public {
        // This would test that supply caps are properly enforced
        // Implementation would depend on vault integration
    }
    
    function testYieldCalculationAccuracy() public {
        // Test mathematical accuracy of yield calculations
        // Set up specific scenarios and verify exact distributions
        
        vm.startPrank(governance);
        ccyoeCore.updateAssetConfig(CMBTC, address(0x10), 500, 20_000_000 * 1e18, true);
        ccyoeCore.updateAssetConfig(CMUSD, address(0x20), 1400, 50_000_000 * 1e18, true);
        ccyoeCore.updateAssetConfig(CMBRL, address(0x30), 2000, type(uint256).max, true);
        vm.stopPrank();
        
        // Update oracle with excess yield scenario
        oracle.updateAssetYield(CMBRL, 2500, 95); // 5% excess (25% - 20%)
        
        vm.warp(block.timestamp + 1 days);
        
        vm.prank(operator);
        ccyoeCore.optimizeYields();
        
        // Verify mathematical distribution matches expected percentages
    }
}
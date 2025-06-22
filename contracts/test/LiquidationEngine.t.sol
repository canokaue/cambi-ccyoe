// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/LiquidationEngine.sol";
import "../src/CCYOECore.sol";
import "../src/CambiOracle.sol";
import "../src/VaultManager.sol";

contract MockVaultForLiquidation {
    uint256 public totalAssets;
    uint256 public totalSupply;
    uint256 public collateralRatio;
    address public owner;
    bool public isLiquidatable;
    
    constructor(address _owner) {
        owner = _owner;
        totalAssets = 1000000 * 1e18;
        totalSupply = 800000 * 1e18;
        collateralRatio = 125; // 125% = 1.25
    }
    
    function setCollateralRatio(uint256 _ratio) external {
        collateralRatio = _ratio;
        isLiquidatable = _ratio < 130; // Liquidation threshold at 130%
    }
    
    function liquidate(uint256 amount) external returns (uint256) {
        totalSupply -= amount;
        return amount * 105 / 100; // 5% liquidation bonus
    }
    
    function getCollateralValue() external view returns (uint256) {
        return totalAssets;
    }
    
    function getDebtValue() external view returns (uint256) {
        return totalSupply;
    }
}

contract LiquidationEngineTest is Test {
    LiquidationEngine public liquidationEngine;
    CCYOECore public ccyoeCore;
    CambiOracle public oracle;
    VaultManager public vaultManager;
    
    MockVaultForLiquidation public vault1;
    MockVaultForLiquidation public vault2;
    MockVaultForLiquidation public vault3;
    
    address public governance = address(0x1);
    address public keeper = address(0x2);
    address public liquidator = address(0x3);
    address public user1 = address(0x4);
    address public user2 = address(0x5);
    address public emergency = address(0x6);
    
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    event LiquidationTriggered(address indexed vault, address indexed liquidator, uint256 debtAmount, uint256 collateralSeized);
    event LiquidationThresholdUpdated(bytes32 indexed assetId, uint256 oldThreshold, uint256 newThreshold);
    event KeeperAdded(address indexed keeper);
    event KeeperRemoved(address indexed keeper);
    event EmergencyLiquidation(address indexed vault, uint256 amount, string reason);

    function setUp() public {
        vm.startPrank(governance);
        
        // Deploy core contracts
        oracle = new CambiOracle(governance);
        
        // Deploy liquidation engine
        liquidationEngine = new LiquidationEngine(
            address(oracle),
            governance
        );
        
        // Grant roles
        liquidationEngine.grantRole(liquidationEngine.KEEPER_ROLE(), keeper);
        liquidationEngine.grantRole(liquidationEngine.EMERGENCY_ROLE(), emergency);
        
        // Deploy mock vaults
        vault1 = new MockVaultForLiquidation(user1);
        vault2 = new MockVaultForLiquidation(user2);
        vault3 = new MockVaultForLiquidation(user1);
        
        // Register vaults with liquidation engine
        liquidationEngine.registerVault(address(vault1), CMBTC);
        liquidationEngine.registerVault(address(vault2), CMUSD);
        liquidationEngine.registerVault(address(vault3), CMBRL);
        
        // Set liquidation thresholds
        liquidationEngine.setLiquidationThreshold(CMBTC, 13000); // 130%
        liquidationEngine.setLiquidationThreshold(CMUSD, 12000); // 120%
        liquidationEngine.setLiquidationThreshold(CMBRL, 11000); // 110%
        
        // Set liquidation bonuses
        liquidationEngine.setLiquidationBonus(CMBTC, 500); // 5%
        liquidationEngine.setLiquidationBonus(CMUSD, 750); // 7.5%
        liquidationEngine.setLiquidationBonus(CMBRL, 1000); // 10%
        
        vm.stopPrank();
    }

    function testInitialConfiguration() public {
        assertEq(liquidationEngine.getLiquidationThreshold(CMBTC), 13000);
        assertEq(liquidationEngine.getLiquidationThreshold(CMUSD), 12000);
        assertEq(liquidationEngine.getLiquidationThreshold(CMBRL), 11000);
        
        assertEq(liquidationEngine.getLiquidationBonus(CMBTC), 500);
        assertEq(liquidationEngine.getLiquidationBonus(CMUSD), 750);
        assertEq(liquidationEngine.getLiquidationBonus(CMBRL), 1000);
        
        assertTrue(liquidationEngine.hasRole(liquidationEngine.KEEPER_ROLE(), keeper));
    }

    function testVaultRegistration() public {
        MockVaultForLiquidation newVault = new MockVaultForLiquidation(user1);
        
        vm.prank(governance);
        liquidationEngine.registerVault(address(newVault), keccak256("cmEUR"));
        
        assertTrue(liquidationEngine.isVaultRegistered(address(newVault)));
    }

    function testLiquidationThresholdUpdate() public {
        uint256 oldThreshold = liquidationEngine.getLiquidationThreshold(CMBTC);
        uint256 newThreshold = 14000; // 140%
        
        vm.expectEmit(true, false, false, true);
        emit LiquidationThresholdUpdated(CMBTC, oldThreshold, newThreshold);
        
        vm.prank(governance);
        liquidationEngine.setLiquidationThreshold(CMBTC, newThreshold);
        
        assertEq(liquidationEngine.getLiquidationThreshold(CMBTC), newThreshold);
    }

    function testLiquidationEligibilityCheck() public {
        // Vault1 starts at 125% ratio, threshold is 130% - should be liquidatable
        vault1.setCollateralRatio(125);
        assertTrue(liquidationEngine.isLiquidatable(address(vault1)));
        
        // Set ratio above threshold - should not be liquidatable
        vault1.setCollateralRatio(135);
        assertFalse(liquidationEngine.isLiquidatable(address(vault1)));
    }

    function testSuccessfulLiquidation() public {
        // Set vault1 below liquidation threshold
        vault1.setCollateralRatio(125); // Below 130% threshold
        
        uint256 liquidationAmount = 100000 * 1e18; // $100k
        
        vm.expectEmit(true, true, false, true);
        emit LiquidationTriggered(address(vault1), liquidator, liquidationAmount, 0);
        
        vm.prank(liquidator);
        liquidationEngine.liquidate(address(vault1), liquidationAmount);
        
        // Check liquidation was recorded
        (uint256 totalLiquidated, uint256 liquidationCount) = liquidationEngine.getLiquidationStats(address(vault1));
        assertEq(totalLiquidated, liquidationAmount);
        assertEq(liquidationCount, 1);
    }

    function testLiquidationOfHealthyVault() public {
        // Vault1 is healthy (above threshold)
        vault1.setCollateralRatio(140); // Above 130% threshold
        
        vm.prank(liquidator);
        vm.expectRevert("Vault not liquidatable");
        liquidationEngine.liquidate(address(vault1), 100000 * 1e18);
    }

    function testPartialLiquidation() public {
        vault1.setCollateralRatio(125); // Below threshold
        
        uint256 partialAmount = 50000 * 1e18; // $50k partial liquidation
        
        vm.prank(liquidator);
        liquidationEngine.liquidate(address(vault1), partialAmount);
        
        // Vault should still be registered but partially liquidated
        (uint256 totalLiquidated,) = liquidationEngine.getLiquidationStats(address(vault1));
        assertEq(totalLiquidated, partialAmount);
    }

    function testLiquidationBonus() public {
        vault1.setCollateralRatio(125);
        
        uint256 liquidationAmount = 100000 * 1e18;
        uint256 expectedBonus = liquidationAmount * 500 / 10000; // 5% bonus
        
        uint256 liquidatorBalanceBefore = liquidator.balance;
        
        vm.prank(liquidator);
        liquidationEngine.liquidate(address(vault1), liquidationAmount);
        
        // Check bonus was applied (this would be more complex in real implementation)
        uint256 actualBonus = liquidationEngine.calculateLiquidationBonus(CMBTC, liquidationAmount);
        assertEq(actualBonus, expectedBonus);
    }

    function testBatchLiquidation() public {
        // Set multiple vaults below threshold
        vault1.setCollateralRatio(125);
        vault2.setCollateralRatio(115);
        vault3.setCollateralRatio(105);
        
        address[] memory vaults = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        
        vaults[0] = address(vault1);
        vaults[1] = address(vault2);
        vaults[2] = address(vault3);
        
        amounts[0] = 50000 * 1e18;
        amounts[1] = 75000 * 1e18;
        amounts[2] = 25000 * 1e18;
        
        vm.prank(keeper);
        liquidationEngine.batchLiquidate(vaults, amounts);
        
        // Check all liquidations were processed
        (uint256 total1,) = liquidationEngine.getLiquidationStats(address(vault1));
        (uint256 total2,) = liquidationEngine.getLiquidationStats(address(vault2));
        (uint256 total3,) = liquidationEngine.getLiquidationStats(address(vault3));
        
        assertEq(total1, amounts[0]);
        assertEq(total2, amounts[1]);
        assertEq(total3, amounts[2]);
    }

    function testEmergencyLiquidation() public {
        uint256 emergencyAmount = 200000 * 1e18; // $200k
        
        vm.expectEmit(true, false, false, true);
        emit EmergencyLiquidation(address(vault1), emergencyAmount, "Market crash");
        
        vm.prank(emergency);
        liquidationEngine.emergencyLiquidate(address(vault1), emergencyAmount, "Market crash");
        
        // Emergency liquidation should bypass normal checks
        (uint256 totalLiquidated,) = liquidationEngine.getLiquidationStats(address(vault1));
        assertEq(totalLiquidated, emergencyAmount);
    }

    function testKeeperManagement() public {
        address newKeeper = address(0x10);
        
        vm.expectEmit(true, false, false, false);
        emit KeeperAdded(newKeeper);
        
        vm.prank(governance);
        liquidationEngine.addKeeper(newKeeper);
        
        assertTrue(liquidationEngine.hasRole(liquidationEngine.KEEPER_ROLE(), newKeeper));
        
        // Remove keeper
        vm.expectEmit(true, false, false, false);
        emit KeeperRemoved(newKeeper);
        
        vm.prank(governance);
        liquidationEngine.removeKeeper(newKeeper);
        
        assertFalse(liquidationEngine.hasRole(liquidationEngine.KEEPER_ROLE(), newKeeper));
    }

    function testLiquidationPrevention() public {
        // Test that liquidation is prevented when vault ratio improves
        vault1.setCollateralRatio(125); // Initially liquidatable
        
        // Vault ratio improves before liquidation
        vault1.setCollateralRatio(135); // Now safe
        
        vm.prank(liquidator);
        vm.expectRevert("Vault not liquidatable");
        liquidationEngine.liquidate(address(vault1), 100000 * 1e18);
    }

    function testMaxLiquidationAmount() public {
        vault1.setCollateralRatio(125);
        
        // Try to liquidate more than maximum allowed (e.g., 50% of debt)
        uint256 excessiveAmount = 500000 * 1e18; // More than 50% of 800k debt
        
        vm.prank(liquidator);
        vm.expectRevert("Liquidation amount exceeds maximum");
        liquidationEngine.liquidate(address(vault1), excessiveAmount);
    }

    function testLiquidationCooldown() public {
        vault1.setCollateralRatio(125);
        
        // First liquidation
        vm.prank(liquidator);
        liquidationEngine.liquidate(address(vault1), 50000 * 1e18);
        
        // Immediate second liquidation should fail due to cooldown
        vm.prank(liquidator);
        vm.expectRevert("Liquidation cooldown active");
        liquidationEngine.liquidate(address(vault1), 50000 * 1e18);
        
        // Fast forward past cooldown period
        vm.warp(block.timestamp + 3600); // 1 hour cooldown
        
        // Should work again
        vm.prank(liquidator);
        liquidationEngine.liquidate(address(vault1), 50000 * 1e18);
    }

    function testGetLiquidatableVaults() public {
        // Set some vaults below threshold
        vault1.setCollateralRatio(125); // Liquidatable
        vault2.setCollateralRatio(135); // Safe
        vault3.setCollateralRatio(100); // Liquidatable
        
        address[] memory liquidatableVaults = liquidationEngine.getLiquidatableVaults();
        
        // Should contain vault1 and vault3 but not vault2
        assertEq(liquidatableVaults.length, 2);
        
        bool vault1Found = false;
        bool vault3Found = false;
        
        for (uint i = 0; i < liquidatableVaults.length; i++) {
            if (liquidatableVaults[i] == address(vault1)) vault1Found = true;
            if (liquidatableVaults[i] == address(vault3)) vault3Found = true;
        }
        
        assertTrue(vault1Found);
        assertTrue(vault3Found);
    }

    function testAccessControl() public {
        // Non-governance cannot set thresholds
        vm.expectRevert();
        liquidationEngine.setLiquidationThreshold(CMBTC, 15000);
        
        // Non-keeper cannot batch liquidate
        vm.expectRevert();
        liquidationEngine.batchLiquidate(new address[](0), new uint256[](0));
        
        // Non-emergency cannot emergency liquidate
        vm.expectRevert();
        liquidationEngine.emergencyLiquidate(address(vault1), 100000 * 1e18, "Unauthorized");
    }

    function testLiquidationStatistics() public {
        vault1.setCollateralRatio(125);
        
        // Perform multiple liquidations
        vm.startPrank(liquidator);
        liquidationEngine.liquidate(address(vault1), 50000 * 1e18);
        
        vm.warp(block.timestamp + 3600); // Wait for cooldown
        liquidationEngine.liquidate(address(vault1), 75000 * 1e18);
        vm.stopPrank();
        
        (uint256 totalLiquidated, uint256 liquidationCount) = liquidationEngine.getLiquidationStats(address(vault1));
        assertEq(totalLiquidated, 125000 * 1e18);
        assertEq(liquidationCount, 2);
        
        // Global statistics
        uint256 globalTotal = liquidationEngine.getTotalLiquidationVolume();
        assertEq(globalTotal, 125000 * 1e18);
    }

    function testFuzzLiquidation(uint256 collateralRatio, uint256 liquidationAmount) public {
        vm.assume(collateralRatio >= 100 && collateralRatio <= 200); // 100% to 200%
        vm.assume(liquidationAmount > 0 && liquidationAmount <= 400000 * 1e18); // Max 50% of debt
        
        vault1.setCollateralRatio(collateralRatio);
        
        if (collateralRatio < 130) { // Below threshold
            vm.prank(liquidator);
            liquidationEngine.liquidate(address(vault1), liquidationAmount);
            
            (uint256 totalLiquidated,) = liquidationEngine.getLiquidationStats(address(vault1));
            assertEq(totalLiquidated, liquidationAmount);
        } else { // Above threshold
            vm.prank(liquidator);
            vm.expectRevert("Vault not liquidatable");
            liquidationEngine.liquidate(address(vault1), liquidationAmount);
        }
    }

    function testPauseUnpause() public {
        // Pause liquidation engine
        vm.prank(emergency);
        liquidationEngine.pause();
        
        vault1.setCollateralRatio(125);
        
        // Liquidations should fail when paused
        vm.prank(liquidator);
        vm.expectRevert("Pausable: paused");
        liquidationEngine.liquidate(address(vault1), 100000 * 1e18);
        
        // Unpause
        vm.prank(emergency);
        liquidationEngine.unpause();
        
        // Should work again
        vm.prank(liquidator);
        liquidationEngine.liquidate(address(vault1), 100000 * 1e18);
    }
}

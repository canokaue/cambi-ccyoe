// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/YieldDistributor.sol";
import "../src/interfaces/IYieldDistributor.sol";

contract MockVault {
    uint256 public currentYield;
    uint256 public totalAssets;
    uint256 public totalSupply;
    
    function setYield(uint256 _yield) external {
        currentYield = _yield;
    }
    
    function setTotalAssets(uint256 _assets) external {
        totalAssets = _assets;
    }
    
    function setTotalSupply(uint256 _supply) external {
        totalSupply = _supply;
    }
    
    function distribute(uint256 amount) external {
        totalAssets += amount;
    }
}

contract YieldDistributorTest is Test {
    YieldDistributor public distributor;
    
    MockVault public btcVault;
    MockVault public usdVault;
    MockVault public brlVault;
    
    address public governance = address(0x1);
    address public ccyoeCore = address(0x2);
    address public treasury = address(0x3);
    address public emergency = address(0x4);
    
    event YieldDistributed(address indexed vault, uint256 amount, uint256 timestamp);
    event AssetYieldBoosted(address indexed vault, uint256 boostAmount, uint256 newYield);
    event TreasuryDistribution(uint256 amount, address indexed treasury);

    function setUp() public {
        vm.startPrank(governance);
        
        distributor = new YieldDistributor(governance);
        
        // Deploy mock vaults
        btcVault = new MockVault();
        usdVault = new MockVault();
        brlVault = new MockVault();
        
        // Set up initial vault states
        btcVault.setTotalAssets(10_000_000 * 1e18); // $10M
        btcVault.setTotalSupply(10_000_000 * 1e18);
        btcVault.setYield(500); // 5%
        
        usdVault.setTotalAssets(20_000_000 * 1e18); // $20M
        usdVault.setTotalSupply(20_000_000 * 1e18);
        usdVault.setYield(1400); // 14%
        
        brlVault.setTotalAssets(50_000_000 * 1e18); // $50M
        brlVault.setTotalSupply(50_000_000 * 1e18);
        brlVault.setYield(2500); // 25%
        
        // Grant roles
        distributor.grantRole(distributor.DISTRIBUTOR_ROLE(), ccyoeCore);
        distributor.grantRole(distributor.EMERGENCY_ROLE(), emergency);
        
        // Register vaults
        distributor.registerVault(address(btcVault), keccak256("cmBTC"));
        distributor.registerVault(address(usdVault), keccak256("cmUSD"));
        distributor.registerVault(address(brlVault), keccak256("cmBRL"));
        
        // Set treasury
        distributor.setTreasury(treasury);
        
        vm.stopPrank();
    }

    function testInitialConfiguration() public {
        assertEq(distributor.treasury(), treasury);
        assertEq(distributor.maxSingleDistribution(), 1_000_000 * 1e18); // $1M default
        assertEq(distributor.maxDailyDistribution(), 10_000_000 * 1e18); // $10M default
        
        assertTrue(distributor.isVaultRegistered(address(btcVault)));
        assertTrue(distributor.isVaultRegistered(address(usdVault)));
        assertTrue(distributor.isVaultRegistered(address(brlVault)));
    }

    function testBasicYieldDistribution() public {
        uint256 distributionAmount = 100_000 * 1e18; // $100k
        
        vm.expectEmit(true, false, false, true);
        emit YieldDistributed(address(btcVault), distributionAmount, block.timestamp);
        
        vm.prank(ccyoeCore);
        distributor.distributeTo(address(btcVault), distributionAmount);
        
        // Check distribution was recorded
        assertEq(distributor.totalDistributed(address(btcVault)), distributionAmount);
        assertEq(distributor.dailyDistributed(), distributionAmount);
    }

    function testYieldBoostCalculation() public {
        uint256 boostAmount = 50_000 * 1e18; // $50k boost
        
        vm.expectEmit(true, false, false, true);
        emit AssetYieldBoosted(address(btcVault), boostAmount, 0); // New yield calculated in contract
        
        vm.prank(ccyoeCore);
        distributor.boostAssetYield(address(btcVault), boostAmount);
        
        // Verify boost was applied
        assertEq(distributor.totalDistributed(address(btcVault)), boostAmount);
    }

    function testSetAssetYield() public {
        uint256 newYield = 600; // 6%
        
        vm.prank(ccyoeCore);
        distributor.setAssetYield(address(btcVault), newYield);
        
        assertEq(distributor.getVaultYield(address(btcVault)), newYield);
    }

    function testTreasuryDistribution() public {
        uint256 treasuryAmount = 50_000 * 1e18; // $50k
        
        vm.expectEmit(false, true, false, true);
        emit TreasuryDistribution(treasuryAmount, treasury);
        
        vm.prank(ccyoeCore);
        distributor.distributeTo(treasury, treasuryAmount);
        
        assertEq(distributor.totalDistributed(treasury), treasuryAmount);
    }

    function testMaxSingleDistributionLimit() public {
        uint256 excessiveAmount = 2_000_000 * 1e18; // $2M > $1M limit
        
        vm.prank(ccyoeCore);
        vm.expectRevert("Exceeds single distribution limit");
        distributor.distributeTo(address(btcVault), excessiveAmount);
    }

    function testMaxDailyDistributionLimit() public {
        uint256 largeAmount = 5_000_000 * 1e18; // $5M
        
        // First distribution should work
        vm.prank(ccyoeCore);
        distributor.distributeTo(address(btcVault), largeAmount);
        
        // Second distribution exceeding daily limit should fail
        vm.prank(ccyoeCore);
        vm.expectRevert("Exceeds daily distribution limit");
        distributor.distributeTo(address(usdVault), largeAmount + 1_000_000 * 1e18);
    }

    function testUnauthorizedDistribution() public {
        vm.expectRevert();
        distributor.distributeTo(address(btcVault), 100_000 * 1e18);
    }

    function testVaultRegistration() public {
        MockVault newVault = new MockVault();
        
        vm.prank(governance);
        distributor.registerVault(address(newVault), keccak256("cmEUR"));
        
        assertTrue(distributor.isVaultRegistered(address(newVault)));
    }

    function testEmergencyPause() public {
        vm.prank(emergency);
        distributor.pause();
        
        vm.prank(ccyoeCore);
        vm.expectRevert("Pausable: paused");
        distributor.distributeTo(address(btcVault), 100_000 * 1e18);
        
        vm.prank(emergency);
        distributor.unpause();
        
        // Should work again
        vm.prank(ccyoeCore);
        distributor.distributeTo(address(btcVault), 100_000 * 1e18);
    }

    function testBatchDistribution() public {
        address[] memory vaults = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        
        vaults[0] = address(btcVault);
        vaults[1] = address(usdVault);
        vaults[2] = address(brlVault);
        
        amounts[0] = 100_000 * 1e18;
        amounts[1] = 200_000 * 1e18;
        amounts[2] = 300_000 * 1e18;
        
        vm.prank(ccyoeCore);
        distributor.batchDistribute(vaults, amounts);
        
        assertEq(distributor.totalDistributed(address(btcVault)), amounts[0]);
        assertEq(distributor.totalDistributed(address(usdVault)), amounts[1]);
        assertEq(distributor.totalDistributed(address(brlVault)), amounts[2]);
    }

    function testDailyLimitReset() public {
        uint256 amount = 8_000_000 * 1e18; // $8M
        
        // Distribute near daily limit
        vm.prank(ccyoeCore);
        distributor.distributeTo(address(btcVault), amount);
        
        assertEq(distributor.dailyDistributed(), amount);
        
        // Fast forward 24 hours
        vm.warp(block.timestamp + 86400);
        
        // Daily limit should reset
        vm.prank(ccyoeCore);
        distributor.distributeTo(address(usdVault), amount); // Should work again
        
        assertEq(distributor.dailyDistributed(), amount);
    }

    function testFuzzDistribution(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 1_000_000 * 1e18);
        
        vm.prank(ccyoeCore);
        distributor.distributeTo(address(btcVault), amount);
        
        assertEq(distributor.totalDistributed(address(btcVault)), amount);
    }
}

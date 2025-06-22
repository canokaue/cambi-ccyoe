// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/RWAVault.sol";
import "../src/interfaces/ICambiOracle.sol";

contract MockRWAToken {
    uint256 public totalSupply;
    uint256 public maturityDate;
    uint256 public yieldRate;
    bool public isMatured;
    
    constructor(uint256 _yieldRate, uint256 _maturityDays) {
        yieldRate = _yieldRate;
        maturityDate = block.timestamp + (_maturityDays * 1 days);
        totalSupply = 1000000 * 1e18;
    }
    
    function mature() external {
        isMatured = true;
    }
    
    function transfer(address to, uint256 amount) external returns (bool) {
        return true;
    }
    
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        return true;
    }
    
    function balanceOf(address account) external view returns (uint256) {
        return 100000 * 1e18;
    }
}

contract RWAVaultTest is Test {
    RWAVault public rwaVault;
    
    MockRWAToken public liqiReceivable;
    MockRWAToken public b3Bond;
    MockRWAToken public bankNote;
    
    address public governance = address(0x1);
    address public rwaManager = address(0x2);
    address public emergency = address(0x3);
    address public user1 = address(0x4);
    address public user2 = address(0x5);
    
    event RWAAdded(address indexed rwaToken, uint256 allocation, uint256 expectedYield);
    event RWARemoved(address indexed rwaToken, uint256 recoveredAmount);
    event RWAMatured(address indexed rwaToken, uint256 finalYield, uint256 payout);
    event PortfolioRebalanced(uint256 totalValue, uint256 newTargetYield);
    event EmergencyWithdrawal(address indexed rwaToken, uint256 amount, string reason);

    function setUp() public {
        vm.startPrank(governance);
        
        rwaVault = new RWAVault(
            "Cambi RWA Vault",
            "cmRWA",
            governance
        );
        
        // Grant roles
        rwaVault.grantRole(rwaVault.RWA_MANAGER_ROLE(), rwaManager);
        rwaVault.grantRole(rwaVault.EMERGENCY_ROLE(), emergency);
        
        // Deploy mock RWA tokens
        liqiReceivable = new MockRWAToken(2500, 60); // 25% yield, 60 days
        b3Bond = new MockRWAToken(1200, 365); // 12% yield, 1 year
        bankNote = new MockRWAToken(1800, 180); // 18% yield, 6 months
        
        vm.stopPrank();
    }

    function testInitialConfiguration() public {
        assertEq(rwaVault.name(), "Cambi RWA Vault");
        assertEq(rwaVault.symbol(), "cmRWA");
        assertEq(rwaVault.totalRWAValue(), 0);
        assertEq(rwaVault.getPortfolioYield(), 0);
        assertEq(rwaVault.getRWACount(), 0);
    }

    function testAddRWAAsset() public {
        uint256 allocation = 1_000_000 * 1e18; // $1M
        uint256 expectedYield = 2500; // 25%
        
        vm.expectEmit(true, false, false, true);
        emit RWAAdded(address(liqiReceivable), allocation, expectedYield);
        
        vm.prank(rwaManager);
        rwaVault.addRWA(
            address(liqiReceivable),
            allocation,
            expectedYield,
            "Liqi Receivable - Export Company"
        );
        
        assertTrue(rwaVault.isRWAActive(address(liqiReceivable)));
        assertEq(rwaVault.getRWAAllocation(address(liqiReceivable)), allocation);
        assertEq(rwaVault.getRWAYield(address(liqiReceivable)), expectedYield);
        assertEq(rwaVault.getRWACount(), 1);
    }

    function testRemoveRWAAsset() public {
        // Add RWA first
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Test");
        
        // Remove it
        vm.expectEmit(true, false, false, true);
        emit RWARemoved(address(liqiReceivable), 0); // No recovery amount in mock
        
        vm.prank(rwaManager);
        rwaVault.removeRWA(address(liqiReceivable));
        
        assertFalse(rwaVault.isRWAActive(address(liqiReceivable)));
        assertEq(rwaVault.getRWACount(), 0);
    }

    function testPortfolioYieldCalculation() public {
        // Add multiple RWA assets
        vm.startPrank(rwaManager);
        
        rwaVault.addRWA(address(liqiReceivable), 2_000_000 * 1e18, 2500, "Liqi 25%"); // $2M at 25%
        rwaVault.addRWA(address(b3Bond), 3_000_000 * 1e18, 1200, "B3 Bond 12%"); // $3M at 12%
        rwaVault.addRWA(address(bankNote), 1_000_000 * 1e18, 1800, "Bank Note 18%"); // $1M at 18%
        
        vm.stopPrank();
        
        // Expected weighted average: (2M*25% + 3M*12% + 1M*18%) / 6M = (50k + 36k + 18k) / 6M = 104k/6M = 17.33%
        uint256 portfolioYield = rwaVault.getPortfolioYield();
        assertApproxEqAbs(portfolioYield, 1733, 5); // ~17.33% with small tolerance
    }

    function testRWAMaturity() public {
        // Add RWA
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Liqi");
        
        // Fast forward to maturity
        vm.warp(block.timestamp + 61 days);
        
        // Mature the token
        liqiReceivable.mature();
        
        vm.expectEmit(true, false, false, true);
        emit RWAMatured(address(liqiReceivable), 2500, 0); // Payout calculated in contract
        
        vm.prank(rwaManager);
        rwaVault.processMaturedRWA(address(liqiReceivable));
        
        // Should be automatically removed after maturity
        assertFalse(rwaVault.isRWAActive(address(liqiReceivable)));
    }

    function testPortfolioRebalancing() public {
        // Add RWAs
        vm.startPrank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 2_000_000 * 1e18, 2500, "Liqi");
        rwaVault.addRWA(address(b3Bond), 1_000_000 * 1e18, 1200, "B3");
        vm.stopPrank();
        
        uint256 totalValue = rwaVault.totalRWAValue();
        
        vm.expectEmit(false, false, false, true);
        emit PortfolioRebalanced(totalValue, 0); // Target yield calculated in contract
        
        vm.prank(rwaManager);
        rwaVault.rebalancePortfolio();
        
        // Check that rebalance timestamp was updated
        assertEq(rwaVault.lastRebalance(), block.timestamp);
    }

    function testRWAAllocationLimits() public {
        // Try to add RWA exceeding single asset limit (assuming 50% max)
        vm.prank(rwaManager);
        vm.expectRevert("Allocation exceeds single asset limit");
        rwaVault.addRWA(
            address(liqiReceivable),
            6_000_000 * 1e18, // $6M > 50% of $10M max
            2500,
            "Excessive allocation"
        );
    }

    function testRWADiversificationRules() public {
        // Add multiple assets from same category to test diversification
        vm.startPrank(rwaManager);
        
        rwaVault.addRWA(address(liqiReceivable), 3_000_000 * 1e18, 2500, "Liqi 1");
        
        // Try to add another Liqi asset that would exceed category limit
        vm.expectRevert("Category allocation limit exceeded");
        rwaVault.addRWA(address(liqiReceivable), 3_000_000 * 1e18, 2500, "Liqi 2");
        
        vm.stopPrank();
    }

    function testEmergencyWithdrawal() public {
        // Add RWA
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Emergency Test");
        
        vm.expectEmit(true, false, false, true);
        emit EmergencyWithdrawal(address(liqiReceivable), 0, "Market stress");
        
        vm.prank(emergency);
        rwaVault.emergencyWithdraw(address(liqiReceivable), "Market stress");
        
        // RWA should be deactivated but not removed (for accounting)
        assertFalse(rwaVault.isRWAActive(address(liqiReceivable)));
    }

    function testYieldDistribution() public {
        // Add RWAs
        vm.startPrank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 2_000_000 * 1e18, 2500, "Liqi");
        vm.stopPrank();
        
        // Simulate yield accrual
        vm.warp(block.timestamp + 30 days);
        
        uint256 accruedYield = rwaVault.getAccruedYield();
        assertGt(accruedYield, 0);
        
        // Distribute yield
        vm.prank(rwaManager);
        rwaVault.distributeYield();
        
        // Check that yield was distributed to vault token holders
        assertEq(rwaVault.getAccruedYield(), 0);
    }

    function testRWAHealthMonitoring() public {
        // Add RWA
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Health Test");
        
        // Check health status
        (bool isHealthy, string memory status) = rwaVault.getRWAHealth(address(liqiReceivable));
        assertTrue(isHealthy);
        assertEq(status, "Healthy");
        
        // Simulate poor performance
        vm.warp(block.timestamp + 90 days); // Past expected maturity
        
        (isHealthy, status) = rwaVault.getRWAHealth(address(liqiReceivable));
        // Health check might flag as concerning
    }

    function testAccessControl() public {
        // Non-manager cannot add RWA
        vm.expectRevert();
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Unauthorized");
        
        // Non-emergency cannot emergency withdraw
        vm.expectRevert();
        rwaVault.emergencyWithdraw(address(liqiReceivable), "Unauthorized");
        
        // Non-governance cannot update limits
        vm.expectRevert();
        rwaVault.updateAllocationLimits(6000, 3000); // 60% single, 30% category
    }

    function testGetAllRWAs() public {
        // Add multiple RWAs
        vm.startPrank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Liqi");
        rwaVault.addRWA(address(b3Bond), 2_000_000 * 1e18, 1200, "B3");
        rwaVault.addRWA(address(bankNote), 500_000 * 1e18, 1800, "Bank");
        vm.stopPrank();
        
        address[] memory rwas = rwaVault.getAllRWAs();
        assertEq(rwas.length, 3);
        
        // Verify all RWAs are included
        bool liqiFound = false;
        bool b3Found = false;
        bool bankFound = false;
        
        for (uint i = 0; i < rwas.length; i++) {
            if (rwas[i] == address(liqiReceivable)) liqiFound = true;
            if (rwas[i] == address(b3Bond)) b3Found = true;
            if (rwas[i] == address(bankNote)) bankFound = true;
        }
        
        assertTrue(liqiFound);
        assertTrue(b3Found);
        assertTrue(bankFound);
    }

    function testFuzzRWAAllocation(uint256 allocation, uint256 yieldRate) public {
        vm.assume(allocation > 0 && allocation <= 5_000_000 * 1e18); // Max $5M
        vm.assume(yieldRate >= 500 && yieldRate <= 5000); // 5% to 50% yield
        
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), allocation, yieldRate, "Fuzz Test");
        
        assertEq(rwaVault.getRWAAllocation(address(liqiReceivable)), allocation);
        assertEq(rwaVault.getRWAYield(address(liqiReceivable)), yieldRate);
    }

    function testVaultTokenMinting() public {
        // Add RWA to create vault value
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 2_000_000 * 1e18, 2500, "Mint Test");
        
        // Mint vault tokens
        vm.prank(governance);
        rwaVault.mint(user1, 1_000_000 * 1e18);
        
        assertEq(rwaVault.balanceOf(user1), 1_000_000 * 1e18);
        assertEq(rwaVault.totalSupply(), 1_000_000 * 1e18);
    }

    function testVaultPauseUnpause() public {
        // Pause vault
        vm.prank(emergency);
        rwaVault.pause();
        
        // Operations should fail when paused
        vm.prank(rwaManager);
        vm.expectRevert("Pausable: paused");
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Paused test");
        
        // Unpause
        vm.prank(emergency);
        rwaVault.unpause();
        
        // Operations should work again
        vm.prank(rwaManager);
        rwaVault.addRWA(address(liqiReceivable), 1_000_000 * 1e18, 2500, "Unpaused test");
        
        assertTrue(rwaVault.isRWAActive(address(liqiReceivable)));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Test.sol";
import "../src/VaultManager.sol";
import "../src/CCYOECore.sol";
import "../src/CambiOracle.sol";
import "../src/YieldDistributor.sol";

contract MockVault {
    uint256 public totalAssets;
    uint256 public totalSupply;
    uint256 public currentYield;
    bool public isActive = true;
    
    function setTotalAssets(uint256 _assets) external {
        totalAssets = _assets;
    }
    
    function setTotalSupply(uint256 _supply) external {
        totalSupply = _supply;
    }
    
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
    }
    
    function burn(address from, uint256 amount) external {
        totalSupply -= amount;
    }
    
    function pause() external {
        isActive = false;
    }
    
    function unpause() external {
        isActive = true;
    }
}

contract VaultManagerTest is Test {
    VaultManager public vaultManager;
    CCYOECore public ccyoeCore;
    CambiOracle public oracle;
    YieldDistributor public distributor;
    
    MockVault public btcVault;
    MockVault public usdVault;
    MockVault public brlVault;
    
    address public governance = address(0x1);
    address public treasury = address(0x2);
    address public user1 = address(0x3);
    address public user2 = address(0x4);
    
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");
    
    event VaultDeployed(bytes32 indexed assetId, address indexed vaultAddress, string assetName);
    event SupplyCapUpdated(bytes32 indexed assetId, uint256 oldCap, uint256 newCap);
    event VaultPaused(bytes32 indexed assetId, address indexed vault);
    event VaultUnpaused(bytes32 indexed assetId, address indexed vault);

    function setUp() public {
        vm.startPrank(governance);
        
        // Deploy core contracts
        oracle = new CambiOracle(governance);
        distributor = new YieldDistributor(governance);
        
        // Deploy CCYOE Core (will set vault manager after)
        ccyoeCore = new CCYOECore(
            address(0), // Will set vault manager later
            address(distributor),
            address(oracle),
            treasury,
            governance
        );
        
        // Deploy vault manager
        vaultManager = new VaultManager(governance, address(ccyoeCore));
        
        // Deploy mock vaults
        btcVault = new MockVault();
        usdVault = new MockVault();
        brlVault = new MockVault();
        
        // Register vaults
        vaultManager.registerVault(CMBTC, address(btcVault), "Cambi Bitcoin");
        vaultManager.registerVault(CMUSD, address(usdVault), "Cambi USD");
        vaultManager.registerVault(CMBRL, address(brlVault), "Cambi Brazilian Real");
        
        // Set initial vault states
        btcVault.setTotalAssets(5_000_000 * 1e18);
        btcVault.setTotalSupply(5_000_000 * 1e18);
        
        usdVault.setTotalAssets(15_000_000 * 1e18);
        usdVault.setTotalSupply(15_000_000 * 1e18);
        
        brlVault.setTotalAssets(30_000_000 * 1e18);
        brlVault.setTotalSupply(30_000_000 * 1e18);
        
        vm.stopPrank();
    }

    function testInitialConfiguration() public {
        assertTrue(vaultManager.isVaultRegistered(CMBTC));
        assertTrue(vaultManager.isVaultRegistered(CMUSD));
        assertTrue(vaultManager.isVaultRegistered(CMBRL));
        
        assertEq(vaultManager.getVaultAddress(CMBTC), address(btcVault));
        assertEq(vaultManager.getVaultAddress(CMUSD), address(usdVault));
        assertEq(vaultManager.getVaultAddress(CMBRL), address(brlVault));
    }

    function testVaultRegistration() public {
        MockVault newVault = new MockVault();
        bytes32 newAssetId = keccak256("cmEUR");
        
        vm.expectEmit(true, true, false, true);
        emit VaultDeployed(newAssetId, address(newVault), "Cambi Euro");
        
        vm.prank(governance);
        vaultManager.registerVault(newAssetId, address(newVault), "Cambi Euro");
        
        assertTrue(vaultManager.isVaultRegistered(newAssetId));
        assertEq(vaultManager.getVaultAddress(newAssetId), address(newVault));
    }

    function testSupplyCapManagement() public {
        uint256 newCap = 30_000_000 * 1e18; // $30M
        uint256 oldCap = vaultManager.getSupplyCap(CMBTC);
        
        vm.expectEmit(true, false, false, true);
        emit SupplyCapUpdated(CMBTC, oldCap, newCap);
        
        vm.prank(governance);
        vaultManager.updateSupplyCap(CMBTC, newCap);
        
        assertEq(vaultManager.getSupplyCap(CMBTC), newCap);
    }

    function testSupplyCapEnforcement() public {
        // Set low cap
        vm.prank(governance);
        vaultManager.updateSupplyCap(CMBTC, 1_000_000 * 1e18); // $1M cap
        
        // Try to mint beyond cap
        vm.prank(governance);
        vm.expectRevert("Supply cap exceeded");
        vaultManager.mint(CMBTC, user1, 2_000_000 * 1e18); // $2M > $1M cap
    }

    function testMintingWithinCap() public {
        uint256 mintAmount = 1_000_000 * 1e18; // $1M
        
        vm.prank(governance);
        vaultManager.mint(CMBTC, user1, mintAmount);
        
        // Check that supply was updated
        uint256 currentSupply = vaultManager.getCurrentSupply(CMBTC);
        assertEq(currentSupply, 5_000_000 * 1e18 + mintAmount);
    }

    function testVaultPausingUnpausing() public {
        vm.expectEmit(true, true, false, false);
        emit VaultPaused(CMBTC, address(btcVault));
        
        vm.prank(governance);
        vaultManager.pauseVault(CMBTC);
        
        assertTrue(vaultManager.isVaultPaused(CMBTC));
        
        // Operations should fail when paused
        vm.prank(governance);
        vm.expectRevert("Vault is paused");
        vaultManager.mint(CMBTC, user1, 1_000_000 * 1e18);
        
        // Unpause
        vm.expectEmit(true, true, false, false);
        emit VaultUnpaused(CMBTC, address(btcVault));
        
        vm.prank(governance);
        vaultManager.unpauseVault(CMBTC);
        
        assertFalse(vaultManager.isVaultPaused(CMBTC));
        
        // Operations should work again
        vm.prank(governance);
        vaultManager.mint(CMBTC, user1, 1_000_000 * 1e18); // Should not revert
    }

    function testEmergencyPauseAll() public {
        vm.prank(governance);
        vaultManager.emergencyPauseAll();
        
        assertTrue(vaultManager.isVaultPaused(CMBTC));
        assertTrue(vaultManager.isVaultPaused(CMUSD));
        assertTrue(vaultManager.isVaultPaused(CMBRL));
    }

    function testGetAllVaults() public {
        (bytes32[] memory assetIds, address[] memory vaultAddresses) = vaultManager.getAllVaults();
        
        assertEq(assetIds.length, 3);
        assertEq(vaultAddresses.length, 3);
        
        // Check that all registered vaults are included
        bool btcFound = false;
        bool usdFound = false;
        bool brlFound = false;
        
        for (uint i = 0; i < assetIds.length; i++) {
            if (assetIds[i] == CMBTC) btcFound = true;
            if (assetIds[i] == CMUSD) usdFound = true;
            if (assetIds[i] == CMBRL) brlFound = true;
        }
        
        assertTrue(btcFound);
        assertTrue(usdFound);
        assertTrue(brlFound);
    }

    function testSupplyTracking() public {
        assertEq(vaultManager.getCurrentSupply(CMBTC), 5_000_000 * 1e18);
        assertEq(vaultManager.getCurrentSupply(CMUSD), 15_000_000 * 1e18);
        assertEq(vaultManager.getCurrentSupply(CMBRL), 30_000_000 * 1e18);
        
        uint256 totalSupply = vaultManager.getTotalProtocolSupply();
        assertEq(totalSupply, 50_000_000 * 1e18);
    }

    function testAccessControl() public {
        // Non-governance cannot register vaults
        vm.expectRevert();
        vaultManager.registerVault(keccak256("cmEUR"), address(0x10), "Euro");
        
        // Non-governance cannot pause vaults
        vm.expectRevert();
        vaultManager.pauseVault(CMBTC);
        
        // Non-governance cannot mint
        vm.expectRevert();
        vaultManager.mint(CMBTC, user1, 1_000_000 * 1e18);
    }

    function testFuzzMinting(uint256 amount) public {
        vm.assume(amount > 0 && amount <= 10_000_000 * 1e18);
        
        vm.prank(governance);
        vaultManager.mint(CMBTC, user1, amount);
        
        uint256 expectedSupply = 5_000_000 * 1e18 + amount;
        assertEq(vaultManager.getCurrentSupply(CMBTC), expectedSupply);
    }
}

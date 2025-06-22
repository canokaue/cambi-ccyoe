// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/CCYOECore.sol";
import "../src/YieldDistributor.sol";
import "../src/VaultManager.sol";
import "../src/CambiOracle.sol";
import "../src/RWAVault.sol";
import "../src/LiquidationEngine.sol";

/**
 * @title Cambi CCYOE Deployment Script
 * @notice Deploys the complete CCYOE system with proper configuration
 * @dev Use this script to deploy to testnet or mainnet
 */
contract Deploy is Script {
    // Deployment configuration
    struct DeployConfig {
        address governance;
        address treasury;
        address operator;
        address emergency;
        address[] dataProviders;
        bool isMainnet;
    }

    // Contract instances
    CCYOECore public ccyoeCore;
    YieldDistributor public yieldDistributor;
    VaultManager public vaultManager;
    CambiOracle public oracle;
    RWAVault public rwaVault;
    LiquidationEngine public liquidationEngine;

    // Asset identifiers
    bytes32 public constant CMBTC = keccak256("cmBTC");
    bytes32 public constant CMUSD = keccak256("cmUSD");
    bytes32 public constant CMBRL = keccak256("cmBRL");

    function run() external {
        // Load deployment configuration
        DeployConfig memory config = _loadDeployConfig();
        
        // Start deployment
        vm.startBroadcast();
        
        console.log("=== Cambi CCYOE Deployment Started ===");
        console.log("Deployer:", msg.sender);
        console.log("Chain ID:", block.chainid);
        console.log("Governance:", config.governance);
        console.log("Treasury:", config.treasury);
        
        // Deploy contracts in dependency order
        _deployOracle(config);
        _deployYieldDistributor(config);
        _deployCCYOECore(config);
        _deployVaultManager(config);
        _deployRWAVault(config);
        _deployLiquidationEngine(config);
        
        // Configure system
        _configureRolesAndPermissions(config);
        _configureOracleDataSources(config);
        _configureAssets(config);
        _configureLiquidation(config);
        
        vm.stopBroadcast();
        
        // Log deployment summary
        _logDeploymentSummary(config);
        
        console.log("=== Deployment Complete ===");
    }

    function _loadDeployConfig() internal view returns (DeployConfig memory) {
        // Load from environment variables or use defaults
        address governance = vm.envOr("GOVERNANCE_ADDRESS", address(0x1));
        address treasury = vm.envOr("TREASURY_ADDRESS", address(0x2));
        address operator = vm.envOr("OPERATOR_ADDRESS", address(0x3));
        address emergency = vm.envOr("EMERGENCY_ADDRESS", address(0x4));
        bool isMainnet = block.chainid == 1 || block.chainid == 137; // Ethereum or Polygon
        
        // Setup data providers
        address[] memory dataProviders = new address[](3);
        dataProviders[0] = vm.envOr("DATA_PROVIDER_1", address(0x5));
        dataProviders[1] = vm.envOr("DATA_PROVIDER_2", address(0x6));
        dataProviders[2] = vm.envOr("DATA_PROVIDER_3", address(0x7));
        
        return DeployConfig({
            governance: governance,
            treasury: treasury,
            operator: operator,
            emergency: emergency,
            dataProviders: dataProviders,
            isMainnet: isMainnet
        });
    }

    function _deployOracle(DeployConfig memory config) internal {
        console.log("Deploying CambiOracle...");
        oracle = new CambiOracle(config.governance);
        console.log("CambiOracle deployed at:", address(oracle));
    }

    function _deployYieldDistributor(DeployConfig memory config) internal {
        console.log("Deploying YieldDistributor...");
        yieldDistributor = new YieldDistributor(config.governance);
        console.log("YieldDistributor deployed at:", address(yieldDistributor));
    }

    function _deployCCYOECore(DeployConfig memory config) internal {
        console.log("Deploying CCYOECore...");
        ccyoeCore = new CCYOECore(
            address(0), // Vault manager set later
            address(yieldDistributor),
            address(oracle),
            config.treasury,
            config.governance
        );
        console.log("CCYOECore deployed at:", address(ccyoeCore));
    }

    function _deployVaultManager(DeployConfig memory config) internal {
        console.log("Deploying VaultManager...");
        vaultManager = new VaultManager(config.governance, address(ccyoeCore));
        console.log("VaultManager deployed at:", address(vaultManager));
        
        // Update CCYOE Core with vault manager address
        // Note: This would require a setter function in CCYOECore
        console.log("VaultManager address needs to be set in CCYOECore manually");
    }

    function _deployRWAVault(DeployConfig memory config) internal {
        console.log("Deploying RWAVault...");
        rwaVault = new RWAVault(
            "Cambi Real World Assets",
            "cmRWA",
            config.governance
        );
        console.log("RWAVault deployed at:", address(rwaVault));
    }

    function _deployLiquidationEngine(DeployConfig memory config) internal {
        console.log("Deploying LiquidationEngine...");
        liquidationEngine = new LiquidationEngine(
            address(oracle),
            config.governance
        );
        console.log("LiquidationEngine deployed at:", address(liquidationEngine));
    }

    function _configureRolesAndPermissions(DeployConfig memory config) internal {
        console.log("Configuring roles and permissions...");
        
        // Grant roles to CCYOE Core
        ccyoeCore.grantRole(ccyoeCore.OPERATOR_ROLE(), config.operator);
        ccyoeCore.grantRole(ccyoeCore.EMERGENCY_ROLE(), config.emergency);
        
        // Grant roles to Yield Distributor
        yieldDistributor.grantRole(yieldDistributor.DISTRIBUTOR_ROLE(), address(ccyoeCore));
        yieldDistributor.grantRole(yieldDistributor.EMERGENCY_ROLE(), config.emergency);
        
        // Grant roles to Oracle
        oracle.grantRole(oracle.EMERGENCY_ROLE(), config.emergency);
        
        // Grant roles to RWA Vault
        rwaVault.grantRole(rwaVault.RWA_MANAGER_ROLE(), config.governance);
        rwaVault.grantRole(rwaVault.EMERGENCY_ROLE(), config.emergency);
        
        // Grant roles to Liquidation Engine
        liquidationEngine.grantRole(liquidationEngine.KEEPER_ROLE(), config.operator);
        liquidationEngine.grantRole(liquidationEngine.EMERGENCY_ROLE(), config.emergency);
        
        console.log("Roles configured successfully");
    }

    function _configureOracleDataSources(DeployConfig memory config) internal {
        console.log("Configuring oracle data sources...");
        
        // Configure cmBTC data sources
        oracle.addDataSource(CMBTC, config.dataProviders[0], 4000, "Institutional BTC Lending");
        oracle.addDataSource(CMBTC, config.dataProviders[1], 3000, "DeFi BTC Yields");
        oracle.addDataSource(CMBTC, config.dataProviders[2], 3000, "Bitcoin Mining Yield");
        
        // Configure cmUSD data sources
        oracle.addDataSource(CMUSD, config.dataProviders[0], 5000, "USD Receivables Primary");
        oracle.addDataSource(CMUSD, config.dataProviders[1], 3000, "USD Receivables Secondary");
        oracle.addDataSource(CMUSD, config.dataProviders[2], 2000, "USD Treasury Baseline");
        
        // Configure cmBRL data sources
        oracle.addDataSource(CMBRL, config.dataProviders[0], 6000, "Liqi Receivables");
        oracle.addDataSource(CMBRL, config.dataProviders[1], 2500, "B3 Government Bonds");
        oracle.addDataSource(CMBRL, config.dataProviders[2], 1500, "Bank Credit Rates");
        
        console.log("Oracle data sources configured");
    }

    function _configureAssets(DeployConfig memory config) internal {
        console.log("Configuring assets...");
        
        // Configure cmBTC (Conservative yields, limited supply)
        ccyoeCore.updateAssetConfig(
            CMBTC,
            address(rwaVault),
            500,  // 5% target yield
            config.isMainnet ? 20_000_000 * 1e18 : 1_000_000 * 1e18, // $20M mainnet, $1M testnet
            300,  // 3% min yield
            800,  // 8% max yield
            true  // active
        );
        
        // Configure cmUSD (Moderate yields, medium supply)
        ccyoeCore.updateAssetConfig(
            CMUSD,
            address(rwaVault),
            1400, // 14% target yield
            config.isMainnet ? 50_000_000 * 1e18 : 5_000_000 * 1e18, // $50M mainnet, $5M testnet
            1200, // 12% min yield
            1800, // 18% max yield
            true  // active
        );
        
        // Configure cmBRL (High yields, unlimited supply)
        ccyoeCore.updateAssetConfig(
            CMBRL,
            address(rwaVault),
            2000, // 20% target yield
            type(uint256).max, // Unlimited supply
            1400, // 14% min yield
            2500, // 25% max yield
            true  // active
        );
        
        // Set distribution configuration (40/30/20/10 strategy)
        ccyoeCore.updateDistributionConfig(
            4000, // 40% to under-supplied assets
            3000, // 30% to strategic growth
            2000, // 20% proportional distribution
            1000, // 10% to treasury
            100,  // 1% rebalance threshold
            config.isMainnet ? 2 hours : 10 minutes // Rebalance frequency
        );
        
        // Set treasury address
        yieldDistributor.setTreasury(config.treasury);
        
        console.log("Assets configured successfully");
    }

    function _configureLiquidation(DeployConfig memory config) internal {
        console.log("Configuring liquidation parameters...");
        
        // Set liquidation thresholds (conservative for mainnet)
        liquidationEngine.setLiquidationThreshold(
            CMBTC, 
            config.isMainnet ? 15000 : 13000 // 150% mainnet, 130% testnet
        );
        liquidationEngine.setLiquidationThreshold(
            CMUSD, 
            config.isMainnet ? 13000 : 12000 // 130% mainnet, 120% testnet
        );
        liquidationEngine.setLiquidationThreshold(
            CMBRL, 
            config.isMainnet ? 12000 : 11000 // 120% mainnet, 110% testnet
        );
        
        // Set liquidation bonuses
        liquidationEngine.setLiquidationBonus(CMBTC, 500);  // 5%
        liquidationEngine.setLiquidationBonus(CMUSD, 750);  // 7.5%
        liquidationEngine.setLiquidationBonus(CMBRL, 1000); // 10%
        
        console.log("Liquidation configured successfully");
    }

    function _logDeploymentSummary(DeployConfig memory config) internal view {
        console.log("\n=== Deployment Summary ===");
        console.log("Network:", config.isMainnet ? "Mainnet" : "Testnet");
        console.log("CCYOECore:", address(ccyoeCore));
        console.log("YieldDistributor:", address(yieldDistributor));
        console.log("VaultManager:", address(vaultManager));
        console.log("CambiOracle:", address(oracle));
        console.log("RWAVault:", address(rwaVault));
        console.log("LiquidationEngine:", address(liquidationEngine));
        
        console.log("\n=== Configuration ===");
        console.log("Governance:", config.governance);
        console.log("Treasury:", config.treasury);
        console.log("Operator:", config.operator);
        console.log("Emergency:", config.emergency);
        
        console.log("\n=== Asset Configuration ===");
        console.log("cmBTC Target Yield: 5.00%");
        console.log("cmUSD Target Yield: 14.00%");
        console.log("cmBRL Target Yield: 20.00%");
        
        console.log("\n=== Distribution Strategy ===");
        console.log("Under-supplied: 40%");
        console.log("Strategic Growth: 30%");
        console.log("Proportional: 20%");
        console.log("Treasury: 10%");
        
        console.log("\n=== Next Steps ===");
        console.log("1. Verify all contract addresses");
        console.log("2. Set VaultManager address in CCYOECore");
        console.log("3. Submit initial oracle data");
        console.log("4. Test system with small amounts");
        console.log("5. Perform security audit");
        console.log("6. Setup monitoring and alerting");
    }

    /**
     * @notice Verify deployment integrity
     * @dev Run this after deployment to ensure everything is configured correctly
     */
    function verifyDeployment() external view {
        console.log("=== Deployment Verification ===");
        
        // Verify contract addresses are set
        require(address(ccyoeCore) != address(0), "CCYOECore not deployed");
        require(address(oracle) != address(0), "Oracle not deployed");
        require(address(yieldDistributor) != address(0), "YieldDistributor not deployed");
        require(address(vaultManager) != address(0), "VaultManager not deployed");
        require(address(rwaVault) != address(0), "RWAVault not deployed");
        require(address(liquidationEngine) != address(0), "LiquidationEngine not deployed");
        
        // Verify asset configurations
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        ICCYOECore.AssetConfig memory usdConfig = ccyoeCore.getAssetConfig(CMUSD);
        ICCYOECore.AssetConfig memory brlConfig = ccyoeCore.getAssetConfig(CMBRL);
        
        require(btcConfig.isActive, "BTC asset not active");
        require(usdConfig.isActive, "USD asset not active");
        require(brlConfig.isActive, "BRL asset not active");
        
        require(btcConfig.targetYield == 500, "BTC target yield incorrect");
        require(usdConfig.targetYield == 1400, "USD target yield incorrect");
        require(brlConfig.targetYield == 2000, "BRL target yield incorrect");
        
        // Verify distribution configuration
        (
            uint256 underSupplied,
            uint256 strategic,
            uint256 proportional,
            uint256 treasury,
            ,
        ) = ccyoeCore.distributionConfig();
        
        require(underSupplied == 4000, "Under-supplied allocation incorrect");
        require(strategic == 3000, "Strategic allocation incorrect");
        require(proportional == 2000, "Proportional allocation incorrect");
        require(treasury == 1000, "Treasury allocation incorrect");
        
        // Verify oracle data sources
        require(oracle.getAssetConfig(CMBTC).totalSources >= 3, "Insufficient BTC sources");
        require(oracle.getAssetConfig(CMUSD).totalSources >= 3, "Insufficient USD sources");
        require(oracle.getAssetConfig(CMBRL).totalSources >= 3, "Insufficient BRL sources");
        
        console.log("✅ All verifications passed");
    }

    /**
     * @notice Emergency deployment functions
     * @dev Use these functions if deployment needs to be paused or resumed
     */
    function emergencyPause() external {
        vm.startBroadcast();
        
        // Pause all contracts
        if (address(ccyoeCore) != address(0)) {
            ccyoeCore.pause();
        }
        if (address(oracle) != address(0)) {
            oracle.pause();
        }
        if (address(yieldDistributor) != address(0)) {
            yieldDistributor.pause();
        }
        
        vm.stopBroadcast();
        console.log("Emergency pause activated");
    }

    function emergencyUnpause() external {
        vm.startBroadcast();
        
        // Unpause all contracts
        if (address(ccyoeCore) != address(0)) {
            ccyoeCore.unpause();
        }
        if (address(oracle) != address(0)) {
            oracle.unpause();
        }
        if (address(yieldDistributor) != address(0)) {
            yieldDistributor.unpause();
        }
        
        vm.stopBroadcast();
        console.log("Emergency pause deactivated");
    }
}

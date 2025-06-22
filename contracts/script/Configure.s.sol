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
 * @title Cambi CCYOE Configuration Script
 * @notice Configures deployed contracts with initial settings and test data
 * @dev Use this script after deployment to initialize the system
 */
contract Configure is Script {
    // Contract addresses (set these after deployment)
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

    // Configuration parameters
    struct ConfigParams {
        bool isTestnet;
        bool submitInitialData;
        bool setupMockRWAs;
        address[] mockDataProviders;
    }

    function run() external {
        // Load contract addresses from environment
        _loadContractAddresses();
        
        // Load configuration
        ConfigParams memory config = _loadConfigParams();
        
        vm.startBroadcast();
        
        console.log("=== Cambi CCYOE Configuration Started ===");
        console.log("Configuring contracts on chain:", block.chainid);
        
        // Configure system parameters
        _configureSystemParameters(config);
        
        // Setup initial oracle data (if requested)
        if (config.submitInitialData) {
            _submitInitialOracleData(config);
        }
        
        // Setup mock RWAs for testing (if requested)
        if (config.setupMockRWAs) {
            _setupMockRWAs(config);
        }
        
        // Configure yield distribution limits
        _configureDistributionLimits(config);
        
        // Setup liquidation parameters
        _configureLiquidationParameters(config);
        
        vm.stopBroadcast();
        
        console.log("=== Configuration Complete ===");
        _logConfigurationSummary(config);
    }

    function _loadContractAddresses() internal {
        // Load from environment variables
        address ccyoeAddress = vm.envAddress("CCYOE_CORE_ADDRESS");
        address oracleAddress = vm.envAddress("ORACLE_ADDRESS");
        address distributorAddress = vm.envAddress("YIELD_DISTRIBUTOR_ADDRESS");
        address vaultManagerAddress = vm.envAddress("VAULT_MANAGER_ADDRESS");
        address rwaVaultAddress = vm.envAddress("RWA_VAULT_ADDRESS");
        address liquidationAddress = vm.envAddress("LIQUIDATION_ENGINE_ADDRESS");
        
        ccyoeCore = CCYOECore(ccyoeAddress);
        oracle = CambiOracle(oracleAddress);
        yieldDistributor = YieldDistributor(distributorAddress);
        vaultManager = VaultManager(vaultManagerAddress);
        rwaVault = RWAVault(rwaVaultAddress);
        liquidationEngine = LiquidationEngine(liquidationAddress);
        
        console.log("Loaded contract addresses:");
        console.log("CCYOECore:", address(ccyoeCore));
        console.log("Oracle:", address(oracle));
        console.log("YieldDistributor:", address(yieldDistributor));
        console.log("VaultManager:", address(vaultManager));
        console.log("RWAVault:", address(rwaVault));
        console.log("LiquidationEngine:", address(liquidationEngine));
    }

    function _loadConfigParams() internal view returns (ConfigParams memory) {
        bool isTestnet = block.chainid != 1 && block.chainid != 137; // Not Ethereum or Polygon mainnet
        bool submitInitialData = vm.envOr("SUBMIT_INITIAL_DATA", true);
        bool setupMockRWAs = vm.envOr("SETUP_MOCK_RWAS", isTestnet);
        
        // Load mock data providers for testing
        address[] memory mockProviders = new address[](5);
        mockProviders[0] = vm.envOr("MOCK_PROVIDER_1", address(0x100));
        mockProviders[1] = vm.envOr("MOCK_PROVIDER_2", address(0x101));
        mockProviders[2] = vm.envOr("MOCK_PROVIDER_3", address(0x102));
        mockProviders[3] = vm.envOr("MOCK_PROVIDER_4", address(0x103));
        mockProviders[4] = vm.envOr("MOCK_PROVIDER_5", address(0x104));
        
        return ConfigParams({
            isTestnet: isTestnet,
            submitInitialData: submitInitialData,
            setupMockRWAs: setupMockRWAs,
            mockDataProviders: mockProviders
        });
    }

    function _configureSystemParameters(ConfigParams memory config) internal {
        console.log("Configuring system parameters...");
        
        // Set more aggressive parameters for testnet
        if (config.isTestnet) {
            // Shorter rebalance intervals for testing
            ccyoeCore.updateDistributionConfig(
                4000, // 40% under-supplied
                3000, // 30% strategic
                2000, // 20% proportional  
                1000, // 10% treasury
                50,   // 0.5% threshold (more sensitive)
                5 minutes // 5 minute rebalance frequency
            );
            
            // Lower oracle confidence requirements for testing
            oracle.updateAssetConfig(CMBTC, 1800, 300, 7000, true);  // 30 min heartbeat, 3% deviation, 70% confidence
            oracle.updateAssetConfig(CMUSD, 1800, 300, 7000, true);
            oracle.updateAssetConfig(CMBRL, 1800, 500, 7000, true);  // 5% deviation for more volatile BRL
            
            console.log("Applied testnet configuration");
        } else {
            // Production parameters
            ccyoeCore.updateDistributionConfig(
                4000, // 40% under-supplied
                3000, // 30% strategic
                2000, // 20% proportional
                1000, // 10% treasury
                100,  // 1% threshold
                2 hours // 2 hour rebalance frequency
            );
            
            // Stricter oracle requirements for production
            oracle.updateAssetConfig(CMBTC, 3600, 200, 8500, true);  // 1 hour heartbeat, 2% deviation, 85% confidence
            oracle.updateAssetConfig(CMUSD, 3600, 250, 8500, true);  // 2.5% deviation for USD
            oracle.updateAssetConfig(CMBRL, 3600, 300, 8000, true);  // 3% deviation, 80% confidence for BRL
            
            console.log("Applied production configuration");
        }
    }

    function _submitInitialOracleData(ConfigParams memory config) internal {
        console.log("Submitting initial oracle data...");
        
        // Submit initial yield data from multiple mock providers
        for (uint i = 0; i < 3; i++) {
            address provider = config.mockDataProviders[i];
            
            // Submit realistic yield data with some variation
            oracle.submitYieldData(CMBTC, 450 + (i * 25), 92 + i);  // 4.5-5.0% BTC yield
            oracle.submitYieldData(CMUSD, 1350 + (i * 50), 95 + i); // 13.5-14.5% USD yield  
            oracle.submitYieldData(CMBRL, 1950 + (i * 75), 88 + i); // 19.5-21.0% BRL yield
            
            console.log("Submitted data from provider", i + 1);
        }
        
        console.log("Initial oracle data submitted");
    }

    function _setupMockRWAs(ConfigParams memory config) internal {
        console.log("Setting up mock RWAs for testing...");
        
        // Create mock Brazilian receivables
        _addMockRWA("Liqi Export Receivable #1", 2_000_000 * 1e18, 2400, 90); // $2M, 24% yield, 90 days
        _addMockRWA("Liqi E-commerce Receivable", 1_500_000 * 1e18, 2200, 60);  // $1.5M, 22% yield, 60 days
        _addMockRWA("B3 Government Bond LTN", 3_000_000 * 1e18, 1300, 365);     // $3M, 13% yield, 1 year
        _addMockRWA("Bank CDB Certificate", 1_000_000 * 1e18, 1800, 180);       // $1M, 18% yield, 6 months
        _addMockRWA("USD Export Hedge", 2_500_000 * 1e18, 1500, 120);           // $2.5M, 15% yield, 4 months
        
        console.log("Mock RWAs configured");
    }

    function _addMockRWA(string memory description, uint256 allocation, uint256 expectedYield, uint256 maturityDays) internal {
        // For testing, we'll use a mock token address
        address mockToken = address(uint160(uint256(keccak256(abi.encode(description)))));
        
        rwaVault.addRWA(
            mockToken,
            allocation,
            expectedYield,
            description
        );
        
        console.log("Added RWA:", description);
        console.log("  Allocation:", allocation / 1e18, "USD");
        console.log("  Expected Yield:", expectedYield / 100, ".", expectedYield % 100, "%");
        console.log("  Maturity:", maturityDays, "days");
    }

    function _configureDistributionLimits(ConfigParams memory config) internal {
        console.log("Configuring distribution limits...");
        
        if (config.isTestnet) {
            // Lower limits for testing
            yieldDistributor.updateDistributionLimits(
                100_000 * 1e18,  // $100k max single distribution
                1_000_000 * 1e18 // $1M max daily distribution
            );
        } else {
            // Production limits
            yieldDistributor.updateDistributionLimits(
                1_000_000 * 1e18,  // $1M max single distribution
                10_000_000 * 1e18  // $10M max daily distribution
            );
        }
        
        console.log("Distribution limits configured");
    }

    function _configureLiquidationParameters(ConfigParams memory config) internal {
        console.log("Configuring liquidation parameters...");
        
        if (config.isTestnet) {
            // More aggressive liquidation for testing
            liquidationEngine.setLiquidationThreshold(CMBTC, 12000); // 120%
            liquidationEngine.setLiquidationThreshold(CMUSD, 11000); // 110%
            liquidationEngine.setLiquidationThreshold(CMBRL, 10500); // 105%
            
            // Higher bonuses for testing
            liquidationEngine.setLiquidationBonus(CMBTC, 750);  // 7.5%
            liquidationEngine.setLiquidationBonus(CMUSD, 1000); // 10%
            liquidationEngine.setLiquidationBonus(CMBRL, 1250); // 12.5%
            
            // Shorter cooldown periods
            liquidationEngine.setCooldownPeriod(CMBTC, 30 minutes);
            liquidationEngine.setCooldownPeriod(CMUSD, 30 minutes);
            liquidationEngine.setCooldownPeriod(CMBRL, 15 minutes);
        } else {
            // Conservative production parameters
            liquidationEngine.setLiquidationThreshold(CMBTC, 15000); // 150%
            liquidationEngine.setLiquidationThreshold(CMUSD, 13000); // 130%
            liquidationEngine.setLiquidationThreshold(CMBRL, 12000); // 120%
            
            // Standard bonuses
            liquidationEngine.setLiquidationBonus(CMBTC, 500);  // 5%
            liquidationEngine.setLiquidationBonus(CMUSD, 750);  // 7.5%
            liquidationEngine.setLiquidationBonus(CMBRL, 1000); // 10%
            
            // Standard cooldown periods
            liquidationEngine.setCooldownPeriod(CMBTC, 2 hours);
            liquidationEngine.setCooldownPeriod(CMUSD, 1 hours);
            liquidationEngine.setCooldownPeriod(CMBRL, 30 minutes);
        }
        
        console.log("Liquidation parameters configured");
    }

    function _logConfigurationSummary(ConfigParams memory config) internal view {
        console.log("\n=== Configuration Summary ===");
        console.log("Network Type:", config.isTestnet ? "Testnet" : "Mainnet");
        console.log("Initial Data Submitted:", config.submitInitialData ? "Yes" : "No");
        console.log("Mock RWAs Setup:", config.setupMockRWAs ? "Yes" : "No");
        
        // Log current yields
        if (config.submitInitialData) {
            console.log("\n=== Current Oracle Yields ===");
            console.log("cmBTC:", oracle.getAssetYield(CMBTC) / 100, ".", oracle.getAssetYield(CMBTC) % 100, "%");
            console.log("cmUSD:", oracle.getAssetYield(CMUSD) / 100, ".", oracle.getAssetYield(CMUSD) % 100, "%");
            console.log("cmBRL:", oracle.getAssetYield(CMBRL) / 100, ".", oracle.getAssetYield(CMBRL) % 100, "%");
        }
        
        // Log RWA portfolio
        if (config.setupMockRWAs) {
            console.log("\n=== RWA Portfolio ===");
            console.log("Total RWA Count:", rwaVault.getRWACount());
            console.log("Portfolio Yield:", rwaVault.getPortfolioYield() / 100, ".", rwaVault.getPortfolioYield() % 100, "%");
            console.log("Total RWA Value: $", rwaVault.totalRWAValue() / 1e18);
        }
        
        console.log("\n=== Next Steps ===");
        console.log("1. Verify oracle data is being aggregated correctly");
        console.log("2. Test yield optimization with excess yields");
        console.log("3. Monitor distribution efficiency");
        console.log("4. Setup automated monitoring and alerting");
        console.log("5. Gradually increase TVL and test liquidations");
    }

    /**
     * @notice Simulate yield optimization scenario
     * @dev Creates excess yield conditions to test CCYOE functionality
     */
    function simulateYieldOptimization() external {
        vm.startBroadcast();
        
        console.log("=== Simulating Yield Optimization ===");
        
        // Submit excess yields to trigger optimization
        oracle.submitYieldData(CMBRL, 2800, 95); // 28% yield vs 20% target = 8% excess
        oracle.submitYieldData(CMUSD, 1600, 98); // 16% yield vs 14% target = 2% excess  
        oracle.submitYieldData(CMBTC, 500, 95);  // 5% yield = at target
        
        console.log("Submitted excess yield data");
        console.log("cmBRL: 28% (8% excess)");
        console.log("cmUSD: 16% (2% excess)");
        console.log("cmBTC: 5% (at target)");
        
        // Wait and trigger optimization
        vm.warp(block.timestamp + 1 hours);
        
        console.log("Triggering yield optimization...");
        ccyoeCore.optimizeYields();
        
        // Log results
        ICCYOECore.YieldMetrics memory metrics = ccyoeCore.getYieldMetrics();
        console.log("Total Excess Yield:", metrics.totalExcessYield, "bp");
        console.log("Distribution Efficiency:", metrics.distributionEfficiency / 100, "%");
        console.log("Rebalance Count:", ccyoeCore.rebalanceCount());
        
        vm.stopBroadcast();
        
        console.log("Simulation complete");
    }

    /**
     * @notice Test emergency procedures
     * @dev Tests emergency pause and recovery functionality
     */
    function testEmergencyProcedures() external {
        vm.startBroadcast();
        
        console.log("=== Testing Emergency Procedures ===");
        
        // Test emergency pause
        console.log("Activating emergency pause...");
        ccyoeCore.pause();
        oracle.pause();
        yieldDistributor.pause();
        
        // Test emergency yield override
        console.log("Setting emergency yields...");
        oracle.emergencySetYield(CMBTC, 200, "Emergency market stress");
        oracle.emergencySetYield(CMUSD, 800, "Emergency market stress");
        oracle.emergencySetYield(CMBRL, 1000, "Emergency market stress");
        
        console.log("Emergency yields set:");
        console.log("cmBTC: 2% (emergency)");
        console.log("cmUSD: 8% (emergency)");
        console.log("cmBRL: 10% (emergency)");
        
        // Test recovery
        console.log("Testing recovery...");
        ccyoeCore.unpause();
        oracle.unpause();
        yieldDistributor.unpause();
        
        // Reset emergency mode
        oracle.resetEmergencyMode(CMBTC);
        oracle.resetEmergencyMode(CMUSD);
        oracle.resetEmergencyMode(CMBRL);
        
        console.log("Emergency procedures tested successfully");
        
        vm.stopBroadcast();
    }

    /**
     * @notice Setup continuous testing scenario
     * @dev Creates ongoing yield variations for extended testing
     */
    function setupContinuousTesting() external {
        vm.startBroadcast();
        
        console.log("=== Setting Up Continuous Testing ===");
        
        // Create varied yield scenarios over time
        for (uint scenario = 1; scenario <= 5; scenario++) {
            console.log("Setting scenario", scenario);
            
            // Vary yields to create different optimization conditions
            uint256 btcYield = 400 + (scenario * 50);  // 4-6.5%
            uint256 usdYield = 1300 + (scenario * 100); // 13-17%
            uint256 brlYield = 2000 + (scenario * 200); // 20-28%
            
            oracle.submitYieldData(CMBTC, btcYield, 90 + scenario);
            oracle.submitYieldData(CMUSD, usdYield, 90 + scenario);
            oracle.submitYieldData(CMBRL, brlYield, 90 + scenario);
            
            // Fast forward time
            vm.warp(block.timestamp + 30 minutes);
            
            // Trigger optimization if thresholds met
            try ccyoeCore.optimizeYields() {
                console.log("Optimization successful for scenario", scenario);
            } catch {
                console.log("Optimization skipped for scenario", scenario);
            }
        }
        
        console.log("Continuous testing scenarios configured");
        console.log("Final rebalance count:", ccyoeCore.rebalanceCount());
        
        vm.stopBroadcast();
    }

    /**
     * @notice Validate system health
     * @dev Checks all components are functioning correctly
     */
    function validateSystemHealth() external view {
        console.log("=== System Health Validation ===");
        
        // Check oracle health
        bool btcValid = oracle.isYieldDataValid(CMBTC);
        bool usdValid = oracle.isYieldDataValid(CMUSD);
        bool brlValid = oracle.isYieldDataValid(CMBRL);
        
        console.log("Oracle Data Validity:");
        console.log("cmBTC:", btcValid ? "Valid" : "Invalid");
        console.log("cmUSD:", usdValid ? "Valid" : "Invalid");
        console.log("cmBRL:", brlValid ? "Valid" : "Invalid");
        
        // Check asset configurations
        ICCYOECore.AssetConfig memory btcConfig = ccyoeCore.getAssetConfig(CMBTC);
        ICCYOECore.AssetConfig memory usdConfig = ccyoeCore.getAssetConfig(CMUSD);
        ICCYOECore.AssetConfig memory brlConfig = ccyoeCore.getAssetConfig(CMBRL);
        
        console.log("\nAsset Status:");
        console.log("cmBTC Active:", btcConfig.isActive ? "Yes" : "No");
        console.log("cmUSD Active:", usdConfig.isActive ? "Yes" : "No");
        console.log("cmBRL Active:", brlConfig.isActive ? "Yes" : "No");
        
        // Check RWA vault health
        uint256 rwaCount = rwaVault.getRWACount();
        uint256 portfolioYield = rwaVault.getPortfolioYield();
        
        console.log("\nRWA Vault Status:");
        console.log("Active RWAs:", rwaCount);
        console.log("Portfolio Yield:", portfolioYield / 100, ".", portfolioYield % 100, "%");
        
        // System health summary
        bool systemHealthy = btcValid && usdValid && brlValid && 
                           btcConfig.isActive && usdConfig.isActive && brlConfig.isActive;
        
        console.log("\nOverall System Health:", systemHealthy ? "HEALTHY" : "DEGRADED");
        
        if (!systemHealthy) {
            console.log("⚠️  System requires attention");
        } else {
            console.log("✅ System operating normally");
        }
    }
}

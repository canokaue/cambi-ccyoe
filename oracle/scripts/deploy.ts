import { ethers } from "hardhat";
import { Contract } from "ethers";

async function main() {
  console.log("🚀 Deploying Cambi Oracle System...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // Deploy CambiOracle
  console.log("\n📊 Deploying CambiOracle...");
  const CambiOracle = await ethers.getContractFactory("CambiOracle");
  const oracle = await CambiOracle.deploy(deployer.address);
  await oracle.waitForDeployment();
  
  const oracleAddress = await oracle.getAddress();
  console.log("✅ CambiOracle deployed to:", oracleAddress);

  // Configure assets
  console.log("\n⚙️ Configuring assets...");
  
  // cmBTC configuration
  const cmBTCId = ethers.id("cmBTC");
  await oracle.configureAsset(
    cmBTCId,
    3600, // 1 hour heartbeat
    200   // 2% deviation threshold
  );
  console.log("✅ Configured cmBTC");

  // cmUSD configuration  
  const cmUSDId = ethers.id("cmUSD");
  await oracle.configureAsset(
    cmUSDId,
    3600, // 1 hour heartbeat
    300   // 3% deviation threshold
  );
  console.log("✅ Configured cmUSD");

  // cmBRL configuration
  const cmBRLId = ethers.id("cmBRL");
  await oracle.configureAsset(
    cmBRLId,
    3600, // 1 hour heartbeat
    500   // 5% deviation threshold
  );
  console.log("✅ Configured cmBRL");

  // Add data sources for cmBTC
  console.log("\n📡 Adding data sources for cmBTC...");
  await oracle.addDataSource(
    cmBTCId,
    deployer.address, // Temporary - replace with actual data provider
    7000, // 70% weight
    "Bitcoin Lending Aggregator"
  );
  
  await oracle.addDataSource(
    cmBTCId,
    deployer.address, // Temporary
    3000, // 30% weight
    "Institutional Bitcoin Yields"
  );
  console.log("✅ Added cmBTC data sources");

  // Add data sources for cmUSD
  console.log("\n📡 Adding data sources for cmUSD...");
  await oracle.addDataSource(
    cmUSDId,
    deployer.address, // Temporary
    6000, // 60% weight
    "Liqi USD Receivables"
  );
  
  await oracle.addDataSource(
    cmUSDId,
    deployer.address, // Temporary
    4000, // 40% weight
    "Brazilian Exporter Receivables"
  );
  console.log("✅ Added cmUSD data sources");

  // Add data sources for cmBRL
  console.log("\n📡 Adding data sources for cmBRL...");
  await oracle.addDataSource(
    cmBRLId,
    deployer.address, // Temporary
    4000, // 40% weight
    "Liqi BRL Receivables"
  );
  
  await oracle.addDataSource(
    cmBRLId,
    deployer.address, // Temporary
    3000, // 30% weight
    "B3 Government Bonds"
  );
  
  await oracle.addDataSource(
    cmBRLId,
    deployer.address, // Temporary
    2000, // 20% weight
    "Bacen SELIC Rate"
  );
  
  await oracle.addDataSource(
    cmBRLId,
    deployer.address, // Temporary
    1000, // 10% weight
    "Bank Aggregate Rates"
  );
  console.log("✅ Added cmBRL data sources");

  // Test oracle functionality
  console.log("\n🧪 Testing oracle functionality...");
  
  // Submit test data for cmBRL
  await oracle.submitYieldData(
    cmBRLId,
    2200, // 22% yield
    85    // 85% confidence
  );
  console.log("✅ Submitted test data for cmBRL");

  // Check if data is valid
  const isValid = await oracle.isYieldDataValid(cmBRLId);
  console.log("✅ cmBRL data validity:", isValid);

  if (isValid) {
    const yieldData = await oracle.getAssetYieldData(cmBRLId);
    console.log("📊 cmBRL yield data:", {
      yield: yieldData.yield.toString() + " bp",
      confidence: yieldData.confidence.toString() + "%",
      timestamp: new Date(Number(yieldData.timestamp) * 1000).toISOString(),
      isValid: yieldData.isValid
    });
  }

  // Deployment summary
  console.log("\n📋 Deployment Summary:");
  console.log("================================");
  console.log("🏛️  CambiOracle:", oracleAddress);
  console.log("🔑 Admin:", deployer.address);
  console.log("⛽ Gas used: Check transaction receipts");
  console.log("🌐 Network:", (await ethers.provider.getNetwork()).name);
  console.log("================================");

  // Environment variables for .env
  console.log("\n📝 Add to your .env file:");
  console.log(`ORACLE_CONTRACT_ADDRESS=${oracleAddress}`);
  
  // Verification command
  if (process.env.ETHERSCAN_API_KEY) {
    console.log("\n🔍 Verify contracts with:");
    console.log(`npx hardhat verify --network ${(await ethers.provider.getNetwork()).name} ${oracleAddress} "${deployer.address}"`);
  }

  console.log("\n🎉 Oracle deployment completed successfully!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });

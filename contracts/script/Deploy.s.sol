// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../src/CCYOECore.sol";
import "../src/YieldDistributor.sol";
import "../src/VaultManager.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy YieldDistributor first
        YieldDistributor yieldDistributor = new YieldDistributor(deployer);
        console.log("YieldDistributor deployed at:", address(yieldDistributor));
        
        // Deploy CCYOECore (with placeholder addresses for now)
        CCYOECore ccyoeCore = new CCYOECore(
            address(0), // Vault manager - will be set later
            address(yieldDistributor),
            address(0), // Oracle - deploy separately
            deployer,   // Treasury
            deployer    // Governance
        );
        console.log("CCYOECore deployed at:", address(ccyoeCore));
        
        // Deploy VaultManager
        VaultManager vaultManager = new VaultManager(deployer, address(ccyoeCore));
        console.log("VaultManager deployed at:", address(vaultManager));
        
        // Grant necessary roles
        yieldDistributor.grantRole(yieldDistributor.DISTRIBUTOR_ROLE(), address(ccyoeCore));
        
        vm.stopBroadcast();
        
        console.log("Deployment completed successfully!");
        console.log("Remember to:");
        console.log("1. Deploy oracle separately");
        console.log("2. Update vault manager address in CCYOECore");
        console.log("3. Configure asset parameters");
        console.log("4. Set up governance multisig");
    }
}
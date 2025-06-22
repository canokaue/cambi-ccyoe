// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockPriceOracle
 * @notice Mock price oracle for testing yield and price data
 */
contract MockPriceOracle is Ownable {
    struct PriceData {
        uint256 price;
        uint256 timestamp;
        uint256 confidence;
        bool isValid;
    }
    
    mapping(bytes32 => PriceData) public prices;
    mapping(bytes32 => uint256) public yields;
    mapping(address => bool) public authorizedUpdaters;
    
    event PriceUpdated(bytes32 indexed asset, uint256 price, uint256 confidence);
    event YieldUpdated(bytes32 indexed asset, uint256 yield);
    
    modifier onlyAuthorized() {
        require(authorizedUpdaters[msg.sender] || msg.sender == owner(), "Not authorized");
        _;
    }
    
    constructor() Ownable(msg.sender) {
        authorizeUpdater(msg.sender);
    }
    
    function authorizeUpdater(address updater) public onlyOwner {
        authorizedUpdaters[updater] = true;
    }
    
    function setPrice(bytes32 asset, uint256 price, uint256 confidence) external onlyAuthorized {
        prices[asset] = PriceData({
            price: price,
            timestamp: block.timestamp,
            confidence: confidence,
            isValid: true
        });
        emit PriceUpdated(asset, price, confidence);
    }
    
    function setYield(bytes32 asset, uint256 yield) external onlyAuthorized {
        yields[asset] = yield;
        emit YieldUpdated(asset, yield);
    }
    
    function getPrice(bytes32 asset) external view returns (uint256, bool) {
        PriceData memory data = prices[asset];
        return (data.price, data.isValid && (block.timestamp - data.timestamp) < 3600);
    }
    
    function getYield(bytes32 asset) external view returns (uint256) {
        return yields[asset];
    }
    
    function simulateVolatility(bytes32 asset, uint256 basePrice, uint256 volatilityPercent) external onlyAuthorized {
        uint256 variation = (basePrice * volatilityPercent) / 10000;
        uint256 randomFactor = uint256(keccak256(abi.encodePacked(block.timestamp, asset))) % 200;
        
        uint256 newPrice;
        if (randomFactor < 100) {
            newPrice = basePrice + (variation * randomFactor) / 100;
        } else {
            newPrice = basePrice - (variation * (randomFactor - 100)) / 100;
        }
        
        setPrice(asset, newPrice, 85 + (randomFactor % 15));
    }
}

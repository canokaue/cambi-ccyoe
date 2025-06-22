// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockERC20
 * @notice Mock ERC20 token for testing purposes
 * @dev Allows minting and burning for comprehensive testing
 */
contract MockERC20 is ERC20, Ownable {
    uint8 private _decimals;
    
    constructor(
        string memory name,
        string memory symbol,
        uint8 tokenDecimals,
        uint256 initialSupply
    ) ERC20(name, symbol) Ownable(msg.sender) {
        _decimals = tokenDecimals;
        if (initialSupply > 0) {
            _mint(msg.sender, initialSupply);
        }
    }
    
    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }
    
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
    
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
    
    function burnFrom(address account, uint256 amount) external {
        uint256 currentAllowance = allowance(account, msg.sender);
        require(currentAllowance >= amount, "ERC20: burn amount exceeds allowance");
        _approve(account, msg.sender, currentAllowance - amount);
        _burn(account, amount);
    }
    
    function setBalance(address account, uint256 newBalance) external onlyOwner {
        uint256 currentBalance = balanceOf(account);
        if (newBalance > currentBalance) {
            _mint(account, newBalance - currentBalance);
        } else if (newBalance < currentBalance) {
            _burn(account, currentBalance - newBalance);
        }
    }
}

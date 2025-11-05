// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MaliciousERC20
 * @dev ERC20 token that always returns false on transfers (for testing SafeERC20)
 */
contract MaliciousERC20 {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false; // Always fail
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false; // Always fail
    }

    function balanceOf(address) external pure returns (uint256) {
        return 1000000 * 10**18;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }
}

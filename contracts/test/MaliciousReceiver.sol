// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MaliciousReceiver
 * @dev Contract for testing reentrancy protection
 */
contract MaliciousReceiver {
    address public target;
    bool public attacking;

    function setTarget(address _target) external {
        target = _target;
    }

    function attackMint(uint256 tier) external payable {
        attacking = true;
        (bool success, ) = target.call{value: msg.value}(
            abi.encodeWithSignature("mintWithBaseToken(uint256)", tier)
        );
        attacking = false;
        require(success, "Attack failed");
    }

    function attackWithdraw() external {
        attacking = true;
        (bool success, ) = target.call(
            abi.encodeWithSignature("withdraw()")
        );
        attacking = false;
        require(success, "Attack failed");
    }

    receive() external payable {
        if (attacking && address(target).balance > 0) {
            // Try to reenter
            (bool success, ) = target.call(
                abi.encodeWithSignature("withdraw()")
            );
        }
    }
}

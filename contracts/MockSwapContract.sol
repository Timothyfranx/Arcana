// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

contract MockSwapContract {
    event SwapExecuted(address indexed executor, uint256 amount);

    function swap(uint256 amount) external {
        emit SwapExecuted(msg.sender, amount);
    }
}

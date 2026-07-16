// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";

contract MockContract {
    address public noxCompute;

    constructor(address _noxCompute) {
        noxCompute = _noxCompute;
    }

    function registerHandle(bytes32 handle, bytes calldata proof) external {
        // 1. Validate the input proof, which grants this contract transient access
        INoxCompute(noxCompute).validateInputProof(handle, msg.sender, proof, TEEType.Uint256);
        
        // 2. Grant the owner (msg.sender) persistent admin access to the handle
        INoxCompute(noxCompute).allow(handle, msg.sender);
    }
}

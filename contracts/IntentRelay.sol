// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";

/**
 * @title IntentRelay
 * @notice Confidential intent relay contract that evaluates encrypted conditions 
 * and grants decryption access to a dedicated relayer when triggered.
 */
contract IntentRelay {
    enum Status { Pending, Triggered, Executed, Cancelled }
    enum CompareOp { GE, LE, GT, LT, EQ, NE }

    struct Intent {
        address owner;
        bytes32 triggerConditionHandle;
        CompareOp compareOp;
        bytes32 targetHandle;
        bytes32[] calldataHandles;
        uint256 calldataLength;
        Status status;
        bytes32 activeCheckHandle;
    }

    address public immutable noxCompute;
    address public immutable relayer;
    uint256 public nextIntentId;

    mapping(uint256 => Intent) public intents;

    event IntentSubmitted(uint256 indexed intentId, address indexed owner);
    event TriggerCheckRequested(uint256 indexed intentId, bytes32 indexed resultHandle);
    event IntentTriggered(uint256 indexed intentId, bytes32 indexed targetHandle, bytes32[] calldataHandles);
    event TriggerCheckFailed(uint256 indexed intentId);
    event IntentExecuted(uint256 indexed intentId);
    event IntentCancelled(uint256 indexed intentId);

    error OnlyRelayer();
    error OnlyOwner();
    error InvalidStatus(Status expected, Status actual);
    error NoActiveCheck();
    error InvalidProofLength();
    error ProofArrayMismatch();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    constructor(address _noxCompute, address _relayer) {
        noxCompute = _noxCompute;
        relayer = _relayer;
    }

    /**
     * @notice Submits a new confidential intent with encrypted trigger, target, and calldata handles.
     */
    function submitIntent(
        bytes32 triggerConditionHandle,
        CompareOp compareOp,
        bytes32 targetHandle,
        bytes32[] calldata calldataHandles,
        uint256 calldataLength,
        bytes calldata triggerProof,
        bytes calldata targetProof,
        bytes[] calldata calldataProofs
    ) external {
        if (calldataHandles.length != calldataProofs.length) revert ProofArrayMismatch();

        // 1. Validate the user-submitted handles using their EIP-712 proofs.
        // This grants transient access to this contract.
        INoxCompute(noxCompute).validateInputProof(triggerConditionHandle, msg.sender, triggerProof, TEEType.Uint256);
        INoxCompute(noxCompute).validateInputProof(targetHandle, msg.sender, targetProof, TEEType.Uint256);
        
        for (uint256 i = 0; i < calldataHandles.length; i++) {
            INoxCompute(noxCompute).validateInputProof(calldataHandles[i], msg.sender, calldataProofs[i], TEEType.Uint256);
        }

        // 2. Persist access for this contract to perform comparisons and grant viewer rights on trigger.
        INoxCompute(noxCompute).allow(triggerConditionHandle, address(this));
        INoxCompute(noxCompute).allow(targetHandle, address(this));
        
        for (uint256 i = 0; i < calldataHandles.length; i++) {
            INoxCompute(noxCompute).allow(calldataHandles[i], address(this));
        }

        // 3. Store the intent
        uint256 intentId = nextIntentId++;
        intents[intentId] = Intent({
            owner: msg.sender,
            triggerConditionHandle: triggerConditionHandle,
            compareOp: compareOp,
            targetHandle: targetHandle,
            calldataHandles: calldataHandles,
            calldataLength: calldataLength,
            status: Status.Pending,
            activeCheckHandle: bytes32(0)
        });

        emit IntentSubmitted(intentId, msg.sender);
    }

    /**
     * @notice Initiates a trigger evaluation by comparing a current market value against the intent condition.
     */
    function requestTriggerCheck(
        uint256 intentId,
        bytes32 currentValueHandle,
        address currentValueOwner,
        bytes calldata currentValueProof
    ) external {
        Intent storage intent = intents[intentId];
        if (intent.status != Status.Pending) revert InvalidStatus(Status.Pending, intent.status);

        // 1. Validate the current market value handle.
        // This grants transient access to this contract.
        INoxCompute(noxCompute).validateInputProof(currentValueHandle, currentValueOwner, currentValueProof, TEEType.Uint256);

        // 2. Call the encrypted comparison operator.
        bytes32 resultHandle;
        if (intent.compareOp == CompareOp.GE) {
            resultHandle = INoxCompute(noxCompute).ge(currentValueHandle, intent.triggerConditionHandle);
        } else if (intent.compareOp == CompareOp.LE) {
            resultHandle = INoxCompute(noxCompute).le(currentValueHandle, intent.triggerConditionHandle);
        } else if (intent.compareOp == CompareOp.GT) {
            resultHandle = INoxCompute(noxCompute).gt(currentValueHandle, intent.triggerConditionHandle);
        } else if (intent.compareOp == CompareOp.LT) {
            resultHandle = INoxCompute(noxCompute).lt(currentValueHandle, intent.triggerConditionHandle);
        } else if (intent.compareOp == CompareOp.EQ) {
            resultHandle = INoxCompute(noxCompute).eq(currentValueHandle, intent.triggerConditionHandle);
        } else {
            resultHandle = INoxCompute(noxCompute).ne(currentValueHandle, intent.triggerConditionHandle);
        }

        // 3. Allow public decryption of the comparison result so keepers/relayers can verify it.
        INoxCompute(noxCompute).allowPublicDecryption(resultHandle);

        intent.activeCheckHandle = resultHandle;

        emit TriggerCheckRequested(intentId, resultHandle);
    }

    /**
     * @notice Verifies the decrypted check result handle. If true, status is set to Triggered and 
     * relayer is granted viewer permissions to target and calldata handles.
     */
    function verifyTrigger(uint256 intentId, bytes calldata decryptionProof) external {
        Intent storage intent = intents[intentId];
        if (intent.status != Status.Pending) revert InvalidStatus(Status.Pending, intent.status);
        if (intent.activeCheckHandle == bytes32(0)) revert NoActiveCheck();

        // 1. Verify the decryption proof of the comparison boolean handle.
        bytes memory decrypted = INoxCompute(noxCompute).validateDecryptionProof(intent.activeCheckHandle, decryptionProof);
        
        // 2. Decode the boolean result robustly (supports 1-byte or 32-byte big-endian representation).
        bool conditionMet = false;
        if (decrypted.length == 1) {
            conditionMet = (decrypted[0] != 0);
        } else if (decrypted.length == 32) {
            conditionMet = (decrypted[31] != 0);
        } else {
            for (uint256 i = 0; i < decrypted.length; i++) {
                if (decrypted[i] != 0) {
                    conditionMet = true;
                    break;
                }
            }
        }

        if (conditionMet) {
            intent.status = Status.Triggered;

            // Grant viewer permissions to the relayer for target and calldata handles.
            INoxCompute(noxCompute).addViewer(intent.targetHandle, relayer);
            for (uint256 i = 0; i < intent.calldataHandles.length; i++) {
                INoxCompute(noxCompute).addViewer(intent.calldataHandles[i], relayer);
            }

            emit IntentTriggered(intentId, intent.targetHandle, intent.calldataHandles);
        } else {
            // Trigger check failed: reset active check handle so it can be evaluated again.
            intent.activeCheckHandle = bytes32(0);
            emit TriggerCheckFailed(intentId);
        }
    }

    /**
     * @notice Marks an intent as successfully executed. Callable only by the relayer.
     */
    function markExecuted(uint256 intentId) external onlyRelayer {
        Intent storage intent = intents[intentId];
        if (intent.status != Status.Triggered) revert InvalidStatus(Status.Triggered, intent.status);

        intent.status = Status.Executed;
        emit IntentExecuted(intentId);
    }

    /**
     * @notice Cancels a pending intent. Callable only by the owner.
     */
    function cancelIntent(uint256 intentId) external {
        Intent storage intent = intents[intentId];
        if (intent.status != Status.Pending) revert InvalidStatus(Status.Pending, intent.status);
        if (msg.sender != intent.owner) revert OnlyOwner();

        intent.status = Status.Cancelled;
        emit IntentCancelled(intentId);
    }

    /**
     * @notice Helper to read the calldata handles array length and items.
     */
    function getCalldataHandles(uint256 intentId) external view returns (bytes32[] memory) {
        return intents[intentId].calldataHandles;
    }
}

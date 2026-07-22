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
    enum LogicOp { NONE, AND, OR }

    struct Intent {
        address owner;
        bytes32 triggerConditionHandle;
        CompareOp compareOp;
        bytes32 triggerConditionHandle2;
        CompareOp compareOp2;
        LogicOp logicOp;
        bytes32 targetHandle;
        bytes32[] calldataHandles;
        uint256 calldataLength;
        Status status;
        bytes32 activeCheckHandle;
    }

    address public immutable noxCompute;
    address public immutable relayer;
    address public immutable priceOracle;
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
    error OnlyOracle();
    error InvalidStatus(Status expected, Status actual);
    error NoActiveCheck();
    error InvalidProofLength();
    error ProofArrayMismatch();
    error InvalidLogicOp();

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert OnlyRelayer();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != priceOracle) revert OnlyOracle();
        _;
    }

    constructor(address _noxCompute, address _relayer, address _priceOracle) {
        noxCompute = _noxCompute;
        relayer = _relayer;
        priceOracle = _priceOracle;
    }

    /**
     * @notice Submits a single-condition confidential intent.
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

        INoxCompute(noxCompute).validateInputProof(triggerConditionHandle, msg.sender, triggerProof, TEEType.Uint256);
        INoxCompute(noxCompute).validateInputProof(targetHandle, msg.sender, targetProof, TEEType.Uint256);
        
        for (uint256 i = 0; i < calldataHandles.length; i++) {
            INoxCompute(noxCompute).validateInputProof(calldataHandles[i], msg.sender, calldataProofs[i], TEEType.Uint256);
        }

        INoxCompute(noxCompute).allow(triggerConditionHandle, address(this));
        INoxCompute(noxCompute).allow(targetHandle, address(this));
        
        for (uint256 i = 0; i < calldataHandles.length; i++) {
            INoxCompute(noxCompute).allow(calldataHandles[i], address(this));
        }

        uint256 intentId = nextIntentId++;
        intents[intentId] = Intent({
            owner: msg.sender,
            triggerConditionHandle: triggerConditionHandle,
            compareOp: compareOp,
            triggerConditionHandle2: bytes32(0),
            compareOp2: CompareOp.GE,
            logicOp: LogicOp.NONE,
            targetHandle: targetHandle,
            calldataHandles: calldataHandles,
            calldataLength: calldataLength,
            status: Status.Pending,
            activeCheckHandle: bytes32(0)
        });

        emit IntentSubmitted(intentId, msg.sender);
    }

    /**
     * @notice Submits a multi-condition confidential intent composed with boolean AND/OR logic.
     */
    function submitIntentMultiCondition(
        bytes32 triggerConditionHandle1,
        CompareOp compareOp1,
        bytes32 triggerConditionHandle2,
        CompareOp compareOp2,
        LogicOp logicOp,
        bytes32 targetHandle,
        bytes32[] calldata calldataHandles,
        uint256 calldataLength,
        bytes calldata triggerProof1,
        bytes calldata triggerProof2,
        bytes calldata targetProof,
        bytes[] calldata calldataProofs
    ) external {
        if (calldataHandles.length != calldataProofs.length) revert ProofArrayMismatch();

        INoxCompute(noxCompute).validateInputProof(triggerConditionHandle1, msg.sender, triggerProof1, TEEType.Uint256);
        INoxCompute(noxCompute).validateInputProof(triggerConditionHandle2, msg.sender, triggerProof2, TEEType.Uint256);
        INoxCompute(noxCompute).validateInputProof(targetHandle, msg.sender, targetProof, TEEType.Uint256);
        
        for (uint256 i = 0; i < calldataHandles.length; i++) {
            INoxCompute(noxCompute).validateInputProof(calldataHandles[i], msg.sender, calldataProofs[i], TEEType.Uint256);
        }

        INoxCompute(noxCompute).allow(triggerConditionHandle1, address(this));
        INoxCompute(noxCompute).allow(triggerConditionHandle2, address(this));
        INoxCompute(noxCompute).allow(targetHandle, address(this));
        
        for (uint256 i = 0; i < calldataHandles.length; i++) {
            INoxCompute(noxCompute).allow(calldataHandles[i], address(this));
        }

        uint256 intentId = nextIntentId++;
        intents[intentId] = Intent({
            owner: msg.sender,
            triggerConditionHandle: triggerConditionHandle1,
            compareOp: compareOp1,
            triggerConditionHandle2: triggerConditionHandle2,
            compareOp2: compareOp2,
            logicOp: logicOp,
            targetHandle: targetHandle,
            calldataHandles: calldataHandles,
            calldataLength: calldataLength,
            status: Status.Pending,
            activeCheckHandle: bytes32(0)
        });

        emit IntentSubmitted(intentId, msg.sender);
    }

    function _evaluateOp(bytes32 valHandle, bytes32 triggerHandle, CompareOp op) internal returns (bytes32) {
        if (op == CompareOp.GE) return INoxCompute(noxCompute).ge(valHandle, triggerHandle);
        if (op == CompareOp.LE) return INoxCompute(noxCompute).le(valHandle, triggerHandle);
        if (op == CompareOp.GT) return INoxCompute(noxCompute).gt(valHandle, triggerHandle);
        if (op == CompareOp.LT) return INoxCompute(noxCompute).lt(valHandle, triggerHandle);
        if (op == CompareOp.EQ) return INoxCompute(noxCompute).eq(valHandle, triggerHandle);
        return INoxCompute(noxCompute).ne(valHandle, triggerHandle);
    }

    /**
     * @notice Initiates a single-condition trigger evaluation.
     */
    function requestTriggerCheck(
        uint256 intentId,
        bytes32 currentValueHandle,
        address currentValueOwner,
        bytes calldata currentValueProof
    ) external onlyOracle {
        Intent storage intent = intents[intentId];
        if (intent.status != Status.Pending) revert InvalidStatus(Status.Pending, intent.status);
        if (intent.logicOp != LogicOp.NONE) revert InvalidLogicOp();

        INoxCompute(noxCompute).validateInputProof(currentValueHandle, currentValueOwner, currentValueProof, TEEType.Uint256);

        bytes32 resultHandle = _evaluateOp(currentValueHandle, intent.triggerConditionHandle, intent.compareOp);

        INoxCompute(noxCompute).allowPublicDecryption(resultHandle);
        intent.activeCheckHandle = resultHandle;

        emit TriggerCheckRequested(intentId, resultHandle);
    }

    /**
     * @notice Initiates a multi-condition trigger evaluation using boolean AND/OR composition inside TEE.
     */
    function requestTriggerCheckMulti(
        uint256 intentId,
        bytes32 currentValueHandle1,
        address owner1,
        bytes calldata proof1,
        bytes32 currentValueHandle2,
        address owner2,
        bytes calldata proof2
    ) external onlyOracle {
        Intent storage intent = intents[intentId];
        if (intent.status != Status.Pending) revert InvalidStatus(Status.Pending, intent.status);
        if (intent.logicOp == LogicOp.NONE) revert InvalidLogicOp();

        INoxCompute(noxCompute).validateInputProof(currentValueHandle1, owner1, proof1, TEEType.Uint256);
        INoxCompute(noxCompute).validateInputProof(currentValueHandle2, owner2, proof2, TEEType.Uint256);

        bytes32 b1 = _evaluateOp(currentValueHandle1, intent.triggerConditionHandle, intent.compareOp);
        bytes32 b2 = _evaluateOp(currentValueHandle2, intent.triggerConditionHandle2, intent.compareOp2);

        bytes32 hZERO = INoxCompute(noxCompute).wrapAsPublicHandle(bytes32(uint256(0)), TEEType.Uint256);
        bytes32 hONE  = INoxCompute(noxCompute).wrapAsPublicHandle(bytes32(uint256(1)), TEEType.Uint256);
        bytes32 hTWO  = INoxCompute(noxCompute).wrapAsPublicHandle(bytes32(uint256(2)), TEEType.Uint256);

        bytes32 u1 = INoxCompute(noxCompute).select(b1, hONE, hZERO);
        bytes32 u2 = INoxCompute(noxCompute).select(b2, hONE, hZERO);

        bytes32 sum = INoxCompute(noxCompute).add(u1, u2);

        bytes32 compositeResult;
        if (intent.logicOp == LogicOp.AND) {
            // Both must be 1 => sum >= 2
            compositeResult = INoxCompute(noxCompute).ge(sum, hTWO);
        } else if (intent.logicOp == LogicOp.OR) {
            // At least one is 1 => sum >= 1
            compositeResult = INoxCompute(noxCompute).ge(sum, hONE);
        } else {
            compositeResult = b1;
        }

        INoxCompute(noxCompute).allowPublicDecryption(compositeResult);
        intent.activeCheckHandle = compositeResult;

        emit TriggerCheckRequested(intentId, compositeResult);
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

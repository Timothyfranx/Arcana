import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { chunkCalldata, rebuildCalldata } from "./handles.js";

export interface ArcanaClientOptions {
  intentRelayAddress: `0x${string}`;
  noxComputeAddress: `0x${string}`;
  gatewayUrl?: `http://${string}` | `https://${string}`;
  subgraphUrl?: `http://${string}` | `https://${string}`;
}

const INTENT_RELAY_ABI = [
  "event IntentTriggered(uint256 indexed intentId, bytes32 indexed targetHandle, bytes32[] calldataHandles)",
  "function nextIntentId() view returns (uint256)",
  "function submitIntent(bytes32 triggerConditionHandle, uint8 compareOp, bytes32 targetHandle, bytes32[] calldataHandles, uint256 calldataLength, bytes triggerProof, bytes targetProof, bytes[] calldataProofs) external",
  "function requestTriggerCheck(uint256 intentId, bytes32 currentValueHandle, address currentValueOwner, bytes calldata currentValueProof) external",
  "function verifyTrigger(uint256 intentId, bytes calldata decryptionProof) external",
  "function markExecuted(uint256 intentId) external",
  "function intents(uint256) view returns (address owner, bytes32 triggerConditionHandle, uint8 compareOp, bytes32 targetHandle, uint256 calldataLength, uint8 status, bytes32 activeCheckHandle)",
  "function getCalldataHandles(uint256) view returns (bytes32[] memory)"
];

export class ArcanaClient {
  public wallet: ethers.Signer;
  public options: ArcanaClientOptions;
  public intentRelayContract: ethers.Contract;
  private handleClientPromise: Promise<any>;

  constructor(wallet: ethers.Signer, options: ArcanaClientOptions) {
    this.wallet = wallet;
    this.options = options;
    this.intentRelayContract = new ethers.Contract(options.intentRelayAddress, INTENT_RELAY_ABI, wallet);
    
    // Lazy initialization of HandleClient
    this.handleClientPromise = createEthersHandleClient(wallet, {
      smartContractAddress: options.noxComputeAddress,
      gatewayUrl: options.gatewayUrl || "https://gateway-testnets.noxprotocol.dev",
      subgraphUrl: options.subgraphUrl || "https://example.com/subgraphs/id/none"
    });
  }

  public async getHandleClient(): Promise<any> {
    return this.handleClientPromise;
  }

  /**
   * Encrypts intent parameters client-side.
   */
  public async encryptIntentParameters(
    targetAddress: string,
    calldataHex: string,
    triggerPrice: bigint
  ) {
    const handleClient = await this.getHandleClient();
    const solidityType = "uint256";
    const recipient = this.options.intentRelayAddress;

    const triggerSecret = await handleClient.encryptInput(triggerPrice, solidityType, recipient);
    const targetSecret = await handleClient.encryptInput(BigInt(targetAddress), solidityType, recipient);

    const chunks = chunkCalldata(calldataHex);
    const calldataHandles: string[] = [];
    const calldataProofs: string[] = [];

    for (const chunk of chunks) {
      const secret = await handleClient.encryptInput(chunk, solidityType, recipient);
      calldataHandles.push(secret.handle);
      calldataProofs.push(secret.handleProof);
    }

    return {
      triggerHandle: triggerSecret.handle,
      triggerProof: triggerSecret.handleProof,
      targetHandle: targetSecret.handle,
      targetProof: targetSecret.handleProof,
      calldataHandles,
      calldataProofs,
      calldataBytesLength: (calldataHex.length - 2) / 2
    };
  }

  /**
   * Submits an encrypted intent on-chain.
   */
  public async submitIntent(params: {
    triggerHandle: string;
    triggerProof: string;
    targetHandle: string;
    targetProof: string;
    calldataHandles: string[];
    calldataProofs: string[];
    calldataBytesLength: number;
    compareOp?: number;
    nonce?: number;
  }) {
    const tx = await this.intentRelayContract.submitIntent(
      params.triggerHandle,
      params.compareOp ?? 0, // 0 = GE by default
      params.targetHandle,
      params.calldataHandles,
      params.calldataBytesLength,
      params.triggerProof,
      params.targetProof,
      params.calldataProofs,
      params.nonce !== undefined ? { nonce: params.nonce } : {}
    );
    return tx;
  }

  /**
   * Encrypts and requests a trigger check on-chain (Oracle operation).
   */
  public async requestTriggerCheck(intentId: bigint, currentPrice: bigint, oracleAddress: string, nonce?: number) {
    const handleClient = await this.getHandleClient();
    const currentPriceSecret = await handleClient.encryptInput(
      currentPrice,
      "uint256",
      this.options.intentRelayAddress
    );

    const tx = await this.intentRelayContract.requestTriggerCheck(
      intentId,
      currentPriceSecret.handle,
      oracleAddress,
      currentPriceSecret.handleProof,
      nonce !== undefined ? { nonce } : {}
    );
    return { tx, currentPriceSecret };
  }

  /**
   * Polls the gateway for decryption proof.
   */
  public async pollDecryptionProof(activeCheckHandle: string, maxAttempts = 90): Promise<string> {
    const handleClient = await this.getHandleClient();
    const apiService = (handleClient as any).apiService;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await apiService.get({
          endpoint: `/v0/public/${activeCheckHandle}`,
          expectedResponse: {
            types: {
              PublicDecryptionResult: [{ name: "decryptionProof", type: "string" }],
            },
            primaryType: "PublicDecryptionResult",
          },
        });
        if (response.status === 200 && response.data?.decryptionProof) {
          return response.data.decryptionProof;
        }
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Timeout waiting for TEE computation decryption proof for check ${activeCheckHandle}`);
  }

  /**
   * Submits the trigger verification proof on-chain (Keeper operation).
   */
  public async verifyTrigger(intentId: bigint, decryptionProof: string, nonce?: number) {
    const tx = await this.intentRelayContract.verifyTrigger(
      intentId,
      decryptionProof,
      nonce !== undefined ? { nonce } : {}
    );
    return tx;
  }

  /**
   * Decrypts target and calldata chunks for a triggered intent (Relayer operation).
   */
  public async decryptExecutionPayload(intentId: bigint, maxRetries = 15): Promise<{
    targetAddress: string;
    calldata: string;
  }> {
    const handleClient = await this.getHandleClient();
    const intent = await this.intentRelayContract.intents(intentId);

    let targetAddress = "";
    // Decrypt target address with retry loop for subgraph synchronization
    for (let retry = 1; retry <= maxRetries; retry++) {
      try {
        const targetDecryption = await handleClient.decrypt(intent.targetHandle);
        targetAddress = "0x" + targetDecryption.value.toString(16).padStart(40, "0");
        break;
      } catch (err: any) {
        if (retry === maxRetries) {
          throw new Error(`Failed to decrypt target address after ${maxRetries} retries: ${err.message || err}`);
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    }

    const calldataHandles = await this.intentRelayContract.getCalldataHandles(intentId);
    
    // Once the target handle successfully decrypts, the subgraph is verified synced.
    // We can decrypt all remaining calldata chunks concurrently in parallel.
    const decryptPromises = calldataHandles.map(async (handle: string, index: number) => {
      for (let retry = 1; retry <= maxRetries; retry++) {
        try {
          const chunkDecryption = await handleClient.decrypt(handle);
          return { index, value: chunkDecryption.value as bigint };
        } catch (err: any) {
          if (retry === maxRetries) {
            throw new Error(`Failed to decrypt calldata chunk handle at index ${index} after ${maxRetries} retries: ${err.message || err}`);
          }
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
      throw new Error(`Failed to decrypt chunk at index ${index}`);
    });

    const results = await Promise.all(decryptPromises);
    // Sort results by index to ensure chunks are reconstructed in correct order
    results.sort((a, b) => a.index - b.index);
    const decryptedChunks = results.map((r) => r.value);

    const calldata = rebuildCalldata(decryptedChunks, Number(intent.calldataLength));
    return { targetAddress, calldata };
  }

  /**
   * Marks an intent as executed successfully.
   */
  public async markExecuted(intentId: bigint, nonce?: number) {
    const tx = await this.intentRelayContract.markExecuted(
      intentId,
      nonce !== undefined ? { nonce } : {}
    );
    return tx;
  }
}

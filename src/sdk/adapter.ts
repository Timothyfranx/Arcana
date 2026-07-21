import { ethers } from "ethers";

export interface SafeTxParams {
  safeAddress: string;
  recipient: string;
  amount: bigint;
  signer: ethers.Signer;
  nonce?: bigint;
}

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes calldata signatures) external returns (bool success)"
];

export class ProtocolAdapter {
  /**
   * Generic function call encoder for any arbitrary smart contract ABI.
   */
  static encodeCall(abi: any, functionName: string, args: any[]): string {
    const iface = new ethers.Interface(abi);
    return iface.encodeFunctionData(functionName, args);
  }

  /**
   * Constructs, signs, and formats a canonical Gnosis Safe (v1.3.0) execTransaction calldata payload.
   */
  static async buildSafeTransaction(params: SafeTxParams): Promise<{ calldata: string; safeNonce: bigint }> {
    const { safeAddress, recipient, amount, signer } = params;
    const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, signer);

    const safeNonce = params.nonce !== undefined ? params.nonce : await safeContract.nonce();
    const innerCalldata = "0x";
    const operation = 0;
    const safeTxGas = 0n;
    const baseGas = 0n;
    const gasPrice = 0n;
    const gasToken = ethers.ZeroAddress;
    const refundReceiver = ethers.ZeroAddress;

    const safeTxHash = await safeContract.getTransactionHash(
      recipient,
      amount,
      innerCalldata,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      safeNonce
    );

    const rawSig = await signer.signMessage(ethers.getBytes(safeTxHash));
    const sig = ethers.Signature.from(rawSig);
    const vAdjusted = sig.v + 4;
    const safeSignature = ethers.hexlify(ethers.concat([
      sig.r,
      sig.s,
      ethers.toBeArray(vAdjusted)
    ]));

    const calldata = safeContract.interface.encodeFunctionData("execTransaction", [
      recipient,
      amount,
      innerCalldata,
      operation,
      safeTxGas,
      baseGas,
      gasPrice,
      gasToken,
      refundReceiver,
      safeSignature
    ]);

    return { calldata, safeNonce };
  }
}

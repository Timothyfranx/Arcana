export function chunkCalldata(calldataHex: string): bigint[] {
  const clean = calldataHex.startsWith("0x") ? calldataHex.slice(2) : calldataHex;
  const remainder = clean.length % 64;
  const padded = remainder === 0 ? clean : clean + "0".repeat(64 - remainder);
  const chunks: bigint[] = [];
  for (let i = 0; i < padded.length; i += 64) {
    const chunkHex = padded.slice(i, i + 64);
    chunks.push(BigInt("0x" + chunkHex));
  }
  return chunks;
}

export function rebuildCalldata(chunks: bigint[], originalLength: number): string {
  let hex = "";
  for (const chunk of chunks) {
    let chunkHex = chunk.toString(16);
    chunkHex = chunkHex.padStart(64, "0");
    hex += chunkHex;
  }
  return "0x" + hex.slice(0, originalLength * 2);
}

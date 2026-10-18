const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const EPOCH = 1704067200000n; // 2024-01-01T00:00:00Z
const NODE_BITS = 10n;
const SEQ_BITS = 12n;
const MAX_NODE = (1n << NODE_BITS) - 1n;
const MAX_SEQ = (1n << SEQ_BITS) - 1n;

let lastTimestamp = -1n;
let sequence = 0n;

/**
 * Encodes a BigInt to a Base62 string.
 * @param n The number to encode
 * @param length The desired length of the string, padded with '0'
 */
export function toBase62(n: bigint, length: number = 11): string {
  if (n === 0n) return "0".padStart(length, "0");
  let res = "";
  let temp = n;
  while (temp > 0n) {
    res = CHARS[Number(temp % 62n)] + res;
    temp /= 62n;
  }
  return res.padStart(length, "0");
}

/**
 * Generates a Snowflake-like 64-bit ID encoded in Base62.
 * Output is exactly 11 characters long.
 * 
 * Structure (63 bits):
 * - 41 bits: Timestamp (ms since 2024-01-01)
 * - 10 bits: Node ID (0-1023)
 * - 12 bits: Sequence (0-4095)
 * 
 * @param nodeId Unique identifier for the generator node (0-1023)
 * @returns 11-character Base62 string
 */
export function make_id(nodeId: number = 0): string {
  let timestamp = BigInt(Date.now());

  if (timestamp < lastTimestamp) {
    throw new Error("Clock moved backwards");
  }

  if (timestamp === lastTimestamp) {
    sequence = (sequence + 1n) & MAX_SEQ;
    if (sequence === 0n) {
      // Wait for the next millisecond
      while (timestamp <= lastTimestamp) {
        timestamp = BigInt(Date.now());
      }
    }
  } else {
    sequence = 0n;
  }

  lastTimestamp = timestamp;

  const id = ((timestamp - EPOCH) << (NODE_BITS + SEQ_BITS)) |
             (BigInt(nodeId & Number(MAX_NODE)) << SEQ_BITS) |
             sequence;

  return toBase62(id);
}

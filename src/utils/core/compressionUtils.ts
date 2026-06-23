/**
 * Compression Utilities for localStorage
 *
 * Uses browser-native gzip (CompressionStream/DecompressionStream) with binary
 * string encoding (Latin1) instead of base64. Each compressed byte is stored as
 * one character — no 33% base64 inflation. localStorage uses UTF-16 internally,
 * so 1 byte of gzip = 1 char = 2 bytes on disk (vs base64: 1 byte = 1.33 chars
 * = 2.67 bytes on disk). This saves ~25% localStorage quota.
 *
 * Format: `gz:<binary string of gzip bytes>`
 * Prefix `gz:` signals compressed data (vs plain JSON).
 */

import { readStreamChunks, combineChunks } from './streamUtils.ts';

/** Minimum payload size to attempt compression (below this, overhead isn't worth it). */
const MIN_COMPRESS_SIZE = 1024;

/**
 * Compress a JSON string using gzip and encode as a binary string for localStorage.
 * Returns the original string if compression doesn't reduce size or isn't available.
 */
export async function compressData(data: string): Promise<string> {
  try {
    if (data.length < MIN_COMPRESS_SIZE) return data;
    if (typeof CompressionStream === 'undefined') return data;

    const input = new TextEncoder().encode(data);

    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();

    writer.write(input);
    writer.close();

    const chunks = await readStreamChunks(reader);
    const compressed = combineChunks(chunks);

    // Encode as binary string (Latin1): one char per byte, zero overhead.
    let binaryStr = '';
    const CHUNK = 8192;
    for (let i = 0; i < compressed.length; i += CHUNK) {
      const slice = compressed.subarray(i, i + CHUNK);
      binaryStr += String.fromCharCode.apply(null, slice as unknown as number[]);
    }

    const stored = `gz:${binaryStr}`;

    // Only use compressed version if it's actually smaller
    return stored.length < data.length ? stored : data;
  } catch (error) {
    console.warn('Compression failed, storing uncompressed:', error);
    return data;
  }
}

/**
 * Decompress data that was compressed with {@link compressData}.
 * Returns the string as-is if it's not compressed.
 */
export async function decompressData(compressedData: string): Promise<string> {
  try {
    if (!compressedData.startsWith('gz:')) {
      return compressedData;
    }
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream not supported');
    }

    // Decode binary string back to bytes
    const binaryStr = compressedData.slice(3); // remove 'gz:'
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    writer.write(bytes);
    writer.close();

    const chunks = await readStreamChunks(reader);
    const combined = combineChunks(chunks);

    return new TextDecoder().decode(combined);
  } catch (error) {
    console.warn('Decompression failed:', error);
    throw error;
  }
}

/**
 * Get compression ratio for debugging.
 */
export function getCompressionRatio(original: string, compressed: string): number {
  if (!compressed.startsWith('gz:')) return 1;
  return original.length / compressed.length;
}

/**
 * Format byte count for human-readable display.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

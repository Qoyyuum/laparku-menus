import { PhotonImage, SamplingFilter, grayscale, resize } from "@cf-wasm/photon";

// Hamming distance at or below this counts as a near-duplicate (aHash is
// crude by design — identical resaves differ by a few bits).
export const PHASH_DUP_THRESHOLD = 10;

// aHash: decode → resize 8×8 → grayscale → compare each pixel to the mean →
// 64-bit fingerprint rendered as 16 hex chars. Throws on undecodable input
// (e.g. a PDF); callers treat that as "no hash".
export async function computePHash(bytes: Uint8Array): Promise<string> {
  const image = PhotonImage.new_from_byteslice(bytes);
  const small = resize(image, 8, 8, SamplingFilter.Triangle);
  try {
    grayscale(small);
    const pixels = small.get_raw_pixels(); // RGBA, 4 bytes per pixel
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += pixels[i * 4] ?? 0;
    const mean = sum / 64;
    let bits = 0n;
    for (let i = 0; i < 64; i++) {
      if ((pixels[i * 4] ?? 0) >= mean) bits |= 1n << BigInt(i);
    }
    return bits.toString(16).padStart(16, "0");
  } finally {
    image.free();
    small.free();
  }
}

export function hammingDistance(a: string, b: string): number {
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

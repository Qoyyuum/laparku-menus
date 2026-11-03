// Metadata forensics — the only AI-generation signals the spec treats as
// near-conclusive: C2PA "generated" credentials, generator params embedded in
// PNG text chunks, and known AI-tool watermarks. A hit means `auto_rejected`;
// absence means nothing (missing camera EXIF is never penalized — screenshots
// and IG downloads strip it legitimately).

export interface ImageMetadataReport {
  // Signature label when found, e.g. "c2pa:trainedAlgorithmicMedia",
  // "sd-parameters", "tool:midjourney". null = no conclusive evidence.
  generatorSignature: string | null;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// C2PA digitalSourceType values that assert generated/synthesized media.
const C2PA_GENERATED = [
  "trainedAlgorithmicMedia",
  "compositeWithTrainedAlgorithmicMedia",
  "algorithmicMedia",
  "algorithmicallyEnhanced",
];

// Distinctive generator/tool names found in PNG tEXt/iTXt params, JPEG EXIF
// Software tags, XMP packets, and watermark text. Kept deliberately specific
// (≥6 chars, low natural-language collision) — a false positive here is an
// auto_rejected real submission.
const GENERATOR_TOOLS = [
  "stable diffusion",
  "stable-diffusion",
  "stablediffusion",
  "midjourney",
  "dall-e",
  "dall·e",
  "dalle3",
  "comfyui",
  "novelai",
  "automatic1111",
  "invokeai",
  "adobe firefly",
  "google imagen",
  "imagen-3",
  "imagen 3",
  "ideogram",
  "leonardo.ai",
  "leonardo ai",
  "dreamstudio",
  "nightcafe",
  "craiyon",
  "bluewillow",
  "bing image creator",
  "microsoft designer",
  "playground ai",
  "black forest labs",
  "recraft",
  "flux.1",
  "seedream",
  "dreamina",
  "kling ai",
  "hailuo ai",
  "openai sora",
  "sora.openai",
  "gpt-image",
  "nano banana",
  "nano-banana",
];

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIG.length && PNG_SIG.every((b, i) => bytes[i] === b);
}

// SD-style parameter blocks ("Steps: …, Sampler: …, CFG scale: …") are a
// generator signature even when no tool name appears — AUTOMATIC1111,
// ComfyUI exports, etc. all embed them.
function hasSdParamBlock(text: string): boolean {
  return (
    text.includes("negative prompt:") ||
    (text.includes("steps:") && text.includes("sampler:") && text.includes("cfg"))
  );
}

// Scan decoded text for markers; returns a signature label or null.
// `text` must already be lowercased.
function scanText(lowered: string): string | null {
  for (const marker of C2PA_GENERATED) {
    if (lowered.includes(marker.toLowerCase())) return `c2pa:${marker}`;
  }
  if (hasSdParamBlock(lowered)) return "sd-parameters";
  for (const marker of GENERATOR_TOOLS) {
    if (lowered.includes(marker)) return `tool:${marker}`;
  }
  return null;
}

// Latin-1 decode preserves byte values 1:1 for ASCII marker matching.
function toLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

// Yield the decoded payloads of PNG text chunks (tEXt / iTXt / zTXt). This is
// where generator params live — e.g. AUTOMATIC1111 writes a `parameters`
// keyword with the full prompt + sampler settings. zTXt payloads stay
// compressed; the whole-file scan below still catches uncompressed text.
function* pngTextChunks(bytes: Uint8Array): Generator<string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIG.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) break; // truncated/malformed
    if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
      yield toLatin1(bytes.subarray(dataStart, dataStart + length));
    }
    if (type === "IEND") break;
    offset = dataStart + length + 4; // +4 skips the chunk CRC
  }
}

export function inspectImageMetadata(bytes: Uint8Array): ImageMetadataReport {
  if (isPng(bytes)) {
    for (const text of pngTextChunks(bytes)) {
      const signature = scanText(text.toLowerCase());
      if (signature) return { generatorSignature: signature };
    }
  }
  // Whole-file scan catches JPEG EXIF Software tags, XMP packets, and C2PA
  // manifests (JUMBF/UUID boxes) in any container.
  const signature = scanText(toLatin1(bytes).toLowerCase());
  return { generatorSignature: signature };
}

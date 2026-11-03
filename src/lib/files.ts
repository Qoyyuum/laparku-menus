export type SniffedFileType = "jpeg" | "png" | "webp" | "pdf";

export const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB per file
export const MAX_FILES = 10; // files per submission

export const SNIFFED_MIME: Record<SniffedFileType, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function hasSig(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

// File type comes from magic bytes — never the declared Content-Type, so a
// renamed .exe labeled image/png is rejected rather than stored.
export function sniffMagic(bytes: Uint8Array): SniffedFileType | null {
  if (hasSig(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (hasSig(bytes, PNG_SIG)) return "png";
  // RIFF....WEBP
  if (hasSig(bytes, [0x52, 0x49, 0x46, 0x46]) && hasSig(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (hasSig(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  return null;
}

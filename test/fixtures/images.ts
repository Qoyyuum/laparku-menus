// Real PNG bytes for the extraction tests (96×64, zlib-deflated, valid CRCs —
// generated offline, base64-embedded here).
//
// `MENU_PNG` decodes cleanly under @cf-wasm/photon, which the aHash step needs.
// `AI_GENERATED_PNG` is the same image plus a `tEXt` chunk keyed `parameters`
// carrying a Stable-Diffusion generation block ("Negative prompt:", "Steps:",
// "Sampler:", "CFG scale: …") — the near-conclusive generator signature the
// forensic scan must auto-reject.
const MENU_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAAx0lEQVR4nO3WwQnDUAxEQVfy+y8vF5+TEgyGsKw0h9eABhZd9/35PnXO0cuebnsBKADQ/wIAYHcAAOwOQANA+pVrDsAEAIUnSADGBgDA7gA0AKRfueYATABQeIIEYGwAAOwOQANA+pVrDsAEAIUnSADGBgDA7gA0AKRfueYATABQeIIEYGwAAOwOQANA+pVrDsAEAIUnSADGBgDA7gA0AKRfueYATABQeIIEYGwAAOwOQANA+pVrDsAEAIUnSADGBgDA7gCE+wH4MgSxCTm5QgAAAABJRU5ErkJggg==";
const AI_GENERATED_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAYAAADlNHIOAAAAk3RFWHRwYXJhbWV0ZXJzAGJlc3QgcXVhbGl0eSwgYSBjYXQKTmVnYXRpdmUgcHJvbXB0OiBibHVycnksIHVnbHkKU3RlcHM6IDMwLCBTYW1wbGVyOiBEUE0rKyAyTSBLYXJyYXMsIENGRyBzY2FsZTogNy41LCBTZWVkOiA0MzIxLCBNb2RlbDogc2RfeGxfYmFzZV8xLjBWsmQVAAAAx0lEQVR4nO3WwQnDUAxEQVfy+y8vF5+TEgyGsKw0h9eABhZd9/35PnXO0cuebnsBKADQ/wIAYHcAAOwOQANA+pVrDsAEAIUnSADGBgDA7gA0AKRfueYATABQeIIEYGwAAOwOQANA+pVrDsAEAIUnSADGBgDA7gA0AKRfueYATABQeIIEYGwAAOwOQANA+pVrDsAEAIUnSADGBgDA7gA0AKRfueYATABQeIIEYGwAAOwOQANA+pVrDsAEAIUnSADGBgDA7gCE+wH4MgSxCTm5QgAAAABJRU5ErkJggg==";

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const MENU_PNG = fromBase64(MENU_B64);
export const AI_GENERATED_PNG = fromBase64(AI_GENERATED_B64);

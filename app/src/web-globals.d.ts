// Web-only DOM globals for the Expo web export. The app's tsconfig (expo
// base) omits lib.dom, and pulling the full DOM lib collides with RN's own
// globals — so the handful of identifiers the web path touches are declared
// here. They only ever run under Platform.OS === "web" (see submit.tsx's
// paste listener and compressImage).

declare const document: {
  addEventListener(type: string, listener: (e: ClipboardEvent) => void): void;
  removeEventListener(type: string, listener: (e: ClipboardEvent) => void): void;
  createElement(tag: string): {
    width: number;
    height: number;
    getContext(
      ctx: "2d",
    ): { drawImage(image: ImageBitmap, dx: number, dy: number, dw: number, dh: number): void } | null;
    toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
  };
};

interface ClipboardEvent {
  clipboardData?: {
    items: { kind: string; type: string; getAsFile(): File | null }[];
  };
}

interface ImageBitmap {
  width: number;
  height: number;
}

declare function createImageBitmap(source: Blob): Promise<ImageBitmap>;

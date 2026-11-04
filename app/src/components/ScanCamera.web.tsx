// Web continuous-decode camera surface (spec §1): @zxing/browser's
// BrowserMultiFormatReader over a getUserMedia <video> element. The native
// BarcodeDetector API is deliberately not used — Safari lacks it; zxing
// covers Chrome/Edge/Safari without WebAssembly gymnastics. Native gets the
// expo-camera implementation in ScanCamera.tsx — Metro resolves the
// platform file. Keep the exported prop shape identical in both files.
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { ScanCameraProps } from "./ScanTab";

// Spec-pinned symbologies: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, QR.
const SCAN_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.QR_CODE,
];

export function ScanCamera({ active, onCode }: ScanCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Decode callbacks fire on zxing's loop, not React's — keep the volatile
  // bits in refs so the effect below only ever runs once per mount. Synced
  // in an effect, not during render (React Compiler rule).
  const activeRef = useRef(active);
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    activeRef.current = active;
    onCodeRef.current = onCode;
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const hints = new Map<DecodeHintType, unknown>();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, SCAN_FORMATS);
    const reader = new BrowserMultiFormatReader(hints);
    let controls: IScannerControls | undefined;
    let cancelled = false;

    reader
      .decodeFromConstraints(
        // Rear camera on phones; desktops ignore facingMode and take the
        // default webcam.
        { audio: false, video: { facingMode: "environment" } },
        video,
        (result) => {
          if (!result || !activeRef.current) return;
          // Chip anchor: zxing result points are in *video-pixel* space —
          // scale into the element's displayed size (objectFit: cover can
          // crop, so this is a best-effort anchor, same status as native).
          const pt = result.getResultPoints()[0];
          let point: { x: number; y: number } | undefined;
          if (pt && video.videoWidth > 0 && video.videoHeight > 0) {
            const rect = video.getBoundingClientRect();
            point = {
              x: (pt.getX() / video.videoWidth) * rect.width,
              y: (pt.getY() / video.videoHeight) * rect.height,
            };
          }
          onCodeRef.current(result.getText(), point);
        },
      )
      .then((c) => {
        if (cancelled) c.stop();
        else controls = c;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          e instanceof Error && /denied|permission|notallowed/i.test(e.message)
            ? "Camera access was denied — type codes in the field below instead."
            : "No camera available — type codes in the field below instead.",
        );
      });

    return () => {
      cancelled = true;
      controls?.stop();
    };
  }, []);

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-black px-6">
        <Text className="text-center text-sm text-neutral-300">{error}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black">
      {/* The zxing reader attaches the camera stream to this element itself;
          it only ever renders on web, where the export target is the DOM. */}
      <video
        ref={videoRef}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
        muted
        playsInline
      />
    </View>
  );
}

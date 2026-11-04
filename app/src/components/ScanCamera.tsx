// Native continuous-decode camera surface (spec §1): expo-camera's
// CameraView with onBarcodeScanned, restricted to the spec-pinned
// symbologies. Web gets the zxing implementation in ScanCamera.web.tsx —
// Metro resolves the platform file, so ScanTab imports "./ScanCamera"
// unconditionally. Keep the exported prop shape identical in both files.
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeType,
} from "expo-camera";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import type { ScanCameraProps } from "./ScanTab";

// Spec-pinned symbologies: EAN-13, EAN-8, UPC-A, UPC-E, Code 128, QR.
const SCAN_BARCODE_TYPES: BarcodeType[] = ["ean13", "ean8", "upc_a", "upc_e", "code128", "qr"];

export function ScanCamera({ active, onCode }: ScanCameraProps) {
  const [permission, requestPermission] = useCameraPermissions();

  const handleScan = useCallback(
    (result: BarcodeScanningResult) => {
      // Chip anchor: the first corner point when provided, else the bounds
      // origin. Coordinates are in the camera view's own space (per the
      // BarcodePoint docs), so the overlay can position directly.
      const point =
        result.cornerPoints && result.cornerPoints.length > 0
          ? { x: result.cornerPoints[0]!.x, y: result.cornerPoints[0]!.y }
          : result.bounds && result.bounds.size.width > 0
            ? { x: result.bounds.origin.x, y: result.bounds.origin.y }
            : undefined;
      onCode(result.data, point);
    },
    [onCode],
  );

  if (!permission) {
    // Permission status still resolving — a dark placeholder matches the
    // camera surface it stands in for.
    return <View className="flex-1 bg-black" />;
  }

  if (!permission.granted) {
    return (
      <View className="flex-1 items-center justify-center gap-2 bg-black px-6">
        <Text className="text-center text-sm text-neutral-300">
          Camera access is needed to scan barcodes.
        </Text>
        {permission.canAskAgain ? (
          <Pressable
            className="rounded-lg bg-emerald-700 px-4 py-2"
            onPress={() => void requestPermission()}
          >
            <Text className="text-sm font-semibold text-white">Allow camera</Text>
          </Pressable>
        ) : (
          <Text className="text-center text-xs text-neutral-400">
            Enable it in your device settings, or type codes in the field below instead.
          </Text>
        )}
      </View>
    );
  }

  return (
    <CameraView
      style={{ flex: 1 }}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: SCAN_BARCODE_TYPES }}
      // Dropping the callback while the submit sheet is open is expo-camera's
      // own pause mechanism — the preview stays warm without decoding.
      onBarcodeScanned={active ? handleScan : undefined}
    />
  );
}

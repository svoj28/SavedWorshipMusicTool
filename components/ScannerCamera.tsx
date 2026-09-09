// components/ScannerCamera.tsx
/**
 * The camera, on native, unchanged.
 *
 * One name for the screens to import, so the QR scanner is the same feature on
 * both platforms: expo-camera here, and getUserMedia plus jsQR in the browser
 * (see ./ScannerCamera.web.tsx), which expo-camera cannot do on web.
 */

export { CameraView, Camera } from 'expo-camera'
export type { BarcodeScanningResult } from 'expo-camera'

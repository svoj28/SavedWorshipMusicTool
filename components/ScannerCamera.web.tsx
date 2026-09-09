// components/ScannerCamera.web.tsx
/**
 * The QR scanner, for the browser.
 *
 * expo-camera will show a preview on web but never reports a barcode, so a
 * scanner built on it there would look like it was working and simply never
 * find anything. That is worse than not offering it - so rather than drop the
 * feature on web, the same job is done with the pieces the browser does have:
 * getUserMedia for the picture, and jsQR to read frames out of it.
 *
 * The surface deliberately matches expo-camera's, so the screens that use it
 * are unchanged and keep their own framing overlay, permission prompt and
 * "already scanned" guard.
 */

import React, { forwardRef, useEffect, useRef } from 'react'
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import jsQR from 'jsqr'

export interface BarcodeScanningResult {
  data: string
  type: string
}

export interface CameraViewProps {
  style?: StyleProp<ViewStyle>
  /** 'back' prefers the rear camera, as on a phone. */
  facing?: 'back' | 'front'
  /** Accepted for parity; this scanner only ever reads QR codes. */
  barcodeScannerSettings?: { barcodeTypes?: string[] }
  /**
   * Undefined once the screen has accepted a code, which is how the callers
   * stop a second read. Scanning keeps running; nothing is delivered.
   */
  onBarcodeScanned?: (result: BarcodeScanningResult) => void
}

/** How often to look at a frame. Fast enough to feel instant, cheap enough
 *  not to pin a laptop fan while somebody lines up a code. */
const SCAN_INTERVAL_MS = 250

export const CameraView = forwardRef<View, CameraViewProps>(function CameraView(
  { style, facing = 'back', onBarcodeScanned },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Held in a ref so changing it does not tear down the camera: the callers
  // pass undefined the moment a code is accepted, and restarting the stream
  // at that point would flash the preview.
  const onScanRef = useRef(onBarcodeScanned)
  useEffect(() => {
    onScanRef.current = onBarcodeScanned
  }, [onBarcodeScanned])

  useEffect(() => {
    let stream: MediaStream | null = null
    let timer: any = null
    let stopped = false

    const scanFrame = () => {
      const video = videoRef.current
      if (!video || !video.videoWidth) return
      if (!onScanRef.current) return

      const canvas = canvasRef.current || (canvasRef.current = document.createElement('canvas'))
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height)

      const found = jsQR(image.data, image.width, image.height, {
        inversionAttempts: 'dontInvert',
      })

      if (found?.data) {
        onScanRef.current?.({ data: found.data, type: 'qr' })
      }
    }

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            // A phone gets its back camera; a laptop with only one camera
            // ignores this rather than failing.
            facingMode: facing === 'back' ? { ideal: 'environment' } : 'user',
          },
          audio: false,
        })
        if (stopped) {
          stream.getTracks().forEach(t => t.stop())
          return
        }

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        video.setAttribute('playsinline', 'true')
        video.muted = true
        await video.play().catch(() => {})

        timer = setInterval(scanFrame, SCAN_INTERVAL_MS)
      } catch {
        // Permission refused, or no camera. The screens ask for permission
        // before mounting this and show their own message, so there is
        // nothing useful to say a second time here.
      }
    }

    start()

    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [facing])

  return (
    <View ref={ref} style={[styles.host, style]}>
      {React.createElement('video', {
        ref: videoRef,
        autoPlay: true,
        playsInline: true,
        muted: true,
        style: { width: '100%', height: '100%', objectFit: 'cover' },
      })}
    </View>
  )
})

/**
 * expo-camera's permission call, in the terms the browser uses.
 *
 * There is no way to ask for the camera without also opening it, so this opens
 * a stream and immediately stops it. That is what makes the browser show its
 * prompt, and the answer is whether it resolved.
 */
export const Camera = {
  async requestCameraPermissionsAsync(): Promise<{ status: 'granted' | 'denied' }> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      stream.getTracks().forEach(t => t.stop())
      return { status: 'granted' }
    } catch {
      return { status: 'denied' }
    }
  },
}

const styles = StyleSheet.create({
  host: { overflow: 'hidden', backgroundColor: '#000' },
})

// components/EngineWebView.web.tsx
/**
 * A WebView, made out of an iframe, for the browser.
 *
 * The app puts all of its audio inside HTML pages - the pad, the metronome,
 * the tuner, the pitch engine - and drives them over the bridge that
 * react-native-webview provides. Those pages are already Web Audio and already
 * plain HTML; the only thing missing in a browser is the bridge itself. So
 * rather than rewrite four engines and a rich-text editor for the web, this
 * puts the bridge back:
 *
 *   page -> app    window.ReactNativeWebView.postMessage(json)
 *   app  -> page   a 'message' event on window, with the json as event.data
 *
 * Both halves are shaped to match what the pages already listen for, so
 * lib/*EngineHtml.ts and the editor document are used verbatim on both
 * platforms.
 *
 * Only the props the app actually passes are implemented. The native-only ones
 * are accepted and ignored rather than omitted, so the call sites stay
 * identical: mediaPlaybackRequiresUserAction and allowsInlineMediaPlayback are
 * decisions the browser makes for itself through its autoplay policy, and
 * androidLayerType has no meaning here.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react'
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'

export interface WebViewMessageEvent {
  nativeEvent: { data: string }
}

export interface EngineWebViewProps {
  source: { html: string; baseUrl?: string }
  onMessage?: (event: WebViewMessageEvent) => void
  onError?: () => void
  onLoadEnd?: () => void
  style?: StyleProp<ViewStyle>
  scrollEnabled?: boolean
  /** Accepted for parity with native; the browser decides these itself. */
  originWhitelist?: string[]
  javaScriptEnabled?: boolean
  domStorageEnabled?: boolean
  mediaPlaybackRequiresUserAction?: boolean
  allowsInlineMediaPlayback?: boolean
  mediaCapturePermissionGrantType?: string
  androidLayerType?: string
  showsVerticalScrollIndicator?: boolean
}

export interface WebViewHandle {
  postMessage(data: string): void
  injectJavaScript(script: string): void
}

/**
 * Installed into the page before its own script runs, so that the first thing
 * an engine does - send({type:'ready'}) at the end of its IIFE - already has
 * somewhere to go.
 *
 * The page is loaded from srcdoc and so is same-origin with us, which is what
 * makes injectJavaScript possible at all. It also means '*' as a target origin
 * is not a leak: the only frame that can receive these is this iframe.
 */
const BRIDGE_SCRIPT = `<script>
  (function () {
    window.ReactNativeWebView = {
      postMessage: function (data) {
        try { window.parent.postMessage(String(data), '*') } catch (e) {}
      }
    };
  })();
</script>`

/** Put the bridge in the <head> so it runs before any engine code. */
function withBridge(html: string): string {
  if (html.includes('<head>')) return html.replace('<head>', '<head>' + BRIDGE_SCRIPT)
  if (html.includes('<html>')) return html.replace('<html>', '<html>' + BRIDGE_SCRIPT)
  return BRIDGE_SCRIPT + html
}

const EngineWebView = forwardRef<WebViewHandle, EngineWebViewProps>(function EngineWebView(
  { source, onMessage, onError, onLoadEnd, style, scrollEnabled = false },
  ref,
) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const html = useMemo(() => withBridge(source.html), [source.html])

  /**
   * Messages sent before the page has parsed its own listeners would be lost,
   * so they wait here until it loads. The pad in particular is started from a
   * controller that has no idea whether the engine is up yet.
   */
  const loadedRef = useRef(false)
  const pendingRef = useRef<string[]>([])

  const deliver = useCallback((data: string) => {
    const win = frameRef.current?.contentWindow
    if (!win || !loadedRef.current) {
      pendingRef.current.push(data)
      return
    }
    try {
      win.postMessage(data, '*')
    } catch {
      // A frame that has gone away is not worth reporting: the engine it was
      // hosting is gone too, and whatever this message was about is moot.
    }
  }, [])

  useImperativeHandle(ref, () => ({
    postMessage(data: string) {
      deliver(data)
    },
    injectJavaScript(script: string) {
      const win = frameRef.current?.contentWindow as any
      if (!win) return
      try {
        // Same-origin srcdoc, so the page's own globals - window.__focusEditor
        // and friends, which the editor toolbar calls - are reachable directly.
        win.eval(script)
      } catch {}
    },
  }), [deliver])

  // Listen for the page talking back. Filtered by frame rather than by origin,
  // because a srcdoc document reports its origin as "null".
  useEffect(() => {
    if (!onMessage) return

    const handler = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return
      if (typeof event.data !== 'string') return
      onMessage({ nativeEvent: { data: event.data } })
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onMessage])

  const handleLoad = useCallback(() => {
    loadedRef.current = true
    const queued = pendingRef.current
    pendingRef.current = []
    queued.forEach(deliver)
    onLoadEnd?.()
  }, [deliver, onLoadEnd])

  // A fresh document means anything queued for the old one is stale, and the
  // new one has not loaded yet.
  useEffect(() => {
    loadedRef.current = false
    pendingRef.current = []
  }, [html])

  return (
    <View style={[styles.host, style]}>
      {React.createElement('iframe', {
        ref: frameRef,
        srcDoc: html,
        onLoad: handleLoad,
        onError,
        scrolling: scrollEnabled ? 'yes' : 'no',
        // Same-origin is required: the bridge reaches into the frame, and the
        // tuner needs a secure context to be offered the microphone at all.
        allow: 'microphone; autoplay',
        style: {
          width: '100%',
          height: '100%',
          border: 'none',
          background: 'transparent',
        },
      })}
    </View>
  )
})

const styles = StyleSheet.create({
  host: { overflow: 'hidden' },
})

export { EngineWebView as WebView }
export default EngineWebView

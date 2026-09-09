// components/EngineWebView.tsx
/**
 * The WebView, on native, unchanged.
 *
 * This module exists only so that the screens can import one name and get the
 * right thing on each platform: react-native-webview here, and an iframe
 * standing in for it in the browser (see ./EngineWebView.web.tsx). The four
 * audio engines and the rich-text editor are all HTML that talks over the
 * ReactNativeWebView bridge, and none of them had to change for the web.
 */

export { WebView, WebView as default } from 'react-native-webview'
export type { WebViewProps } from 'react-native-webview'

const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

/**
 * The web build is the same app, with the parts that only exist on a device
 * swapped out at resolve time rather than branched on inside every file.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web') {
    // The native SQLite bindings. db/index.web.ts is picked up by extension and
    // uses sql.js instead, so nothing on web should reach these at all - this
    // is here so that an accidental import fails as an empty module rather
    // than dragging native code into the bundle.
    if (
      moduleName.includes('expo-sqlite') ||
      moduleName.includes('@nozbe/watermelondb') ||
      moduleName.includes('wa-sqlite')
    ) {
      return { type: 'empty' }
    }

    // react-native-youtube-iframe reaches for react-native-web-webview on web,
    // a package that has not kept up with react-native-web and that we would
    // otherwise have to add just for this. It wants exactly what our own
    // WebView stand-in already provides - source={{html}}, onMessage, and
    // injectJavaScript on the ref - so point it there.
    if (moduleName === 'react-native-web-webview') {
      return {
        type: 'sourceFile',
        filePath: path.resolve(__dirname, 'components/EngineWebView.web.tsx'),
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config

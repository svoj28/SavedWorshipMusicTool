// lib/webAlert.ts
/**
 * Nothing to install on native: Alert.alert is already real there.
 *
 * The browser gets ./webAlert.web.ts, which supplies the implementation
 * react-native-web leaves as an empty function.
 */

export function installWebAlert(): void {}

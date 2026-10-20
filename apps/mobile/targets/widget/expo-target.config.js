// WidgetKit-Erweiterung (über @bacons/apple-targets beim Prebuild erzeugt).
// Interaktive Widgets (Button mit App Intent) brauchen iOS 17.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'TimelogWidget',
  displayName: 'TimeLog',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  frameworks: ['SwiftUI', 'WidgetKit', 'AppIntents', 'Network'],
  colors: {
    $accent: { color: '#0B5CAD', darkColor: '#7FB6F0' },
    $widgetBackground: { color: '#FFFFFF', darkColor: '#1C1C1E' },
  },
  entitlements: {
    'com.apple.security.application-groups':
      config.ios?.entitlements?.['com.apple.security.application-groups'] ?? [],
  },
});

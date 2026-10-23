Pod::Spec.new do |s|
  s.name           = 'TimelogNative'
  s.version        = '0.1.0'
  s.summary        = 'TimeLog: Geofence, Kurzbefehle und Widget-Anbindung'
  s.description    = 'Lokales Expo-Modul der TimeLog-App'
  s.license        = 'UNLICENSED'
  s.author         = 'TimeLog'
  s.homepage       = 'https://example.invalid/timelog'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.frameworks = 'CoreLocation', 'Network', 'WidgetKit', 'UserNotifications'

  s.source_files = '*.swift'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
end

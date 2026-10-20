// Startet die Geofence-Überwachung beim Start der App – auch wenn Core Location die App im
// Hintergrund startet. Mit dem Szenen-Lebenszyklus (iOS 27 SDK) läuft dabei kein React Native;
// die Ereignisse landen in der App Group und werden beim nächsten Öffnen übertragen.
import ExpoModulesCore
import UIKit

public class TimelogAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    GeofenceManager.shared.startAtLaunch()
    return true
  }
}

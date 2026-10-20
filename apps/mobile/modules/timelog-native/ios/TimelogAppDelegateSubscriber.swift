// Startet die Geofence-Überwachung beim Start der App – auch wenn Core Location die App im
// Hintergrund startet. Mit dem Szenen-Lebenszyklus (iOS 27 SDK) läuft dabei kein React Native;
// die Ereignisse landen in der App Group und werden beim nächsten Öffnen übertragen.
// Außerdem: Handler für die Aktion „Stimmt“ der Rückfragen (läuft auch ohne React Native).
import ExpoModulesCore
import ExpoNotifications
import UIKit

public class TimelogAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    GeofenceManager.shared.startAtLaunch()
    NotificationCenterManager.shared.addDelegate(TimelogPromptDelegate.shared)
    return true
  }
}

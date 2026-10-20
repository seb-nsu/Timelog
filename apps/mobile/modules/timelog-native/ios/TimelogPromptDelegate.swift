// Aktion „Stimmt“ der Rückfragen (Kategorie timelog.end_confirm / timelog.end_missing).
// Die Aktion öffnet die App nicht (UNNotificationAction ohne .foreground); iOS startet die App
// dafür im Hintergrund, ohne dass JavaScript läuft. Das Ereignis landet in der App Group und
// wird beim nächsten Öffnen übertragen. Andere Aktionen bleiben bei expo-notifications (JS).
import ExpoNotifications
import UserNotifications

final class TimelogPromptDelegate: NotificationDelegate {
  static let shared = TimelogPromptDelegate()

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    guard response.actionIdentifier == "confirm" else { return false }
    let request = response.notification.request
    guard let body = request.content.userInfo["body"] as? [String: Any] else { return false }
    let kind = (body["kind"] as? String) ?? ""
    let session = (body["sessionId"] as? String) ?? ""
    TimelogShared.answerPrompt(body, key: "\(kind):\(session):\(request.identifier)")
    // false: expo-notifications reicht die Antwort weiter an JS (dort auf iOS ohne Wirkung)
    return false
  }
}

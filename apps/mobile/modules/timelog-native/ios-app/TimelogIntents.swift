// TimelogIntents.swift – App Intents im App-Target (das Config-Plugin plugins/withTimelog.js
// kopiert diese Datei beim Prebuild in das iOS-Projekt). App Intents müssen im Binary der App
// liegen, damit die Kurzbefehle-App sie findet.
//
// „Arbeitsnetz verbunden“ ist für die persönliche Automation gedacht:
// Kurzbefehle → Automation → WLAN → <Arbeits-WLAN> → „Sofort ausführen“.
// Der WLAN-Name bleibt in der Kurzbefehle-App; TimeLog erfährt ihn nie.
// Ungeprüft auf Gerät, siehe docs/MOBILE.md.
//
// Sprache: Titel und Beschreibungen sind deutsche Schlüssel; die englischen Texte stehen in
// locales/en.json („Localizable.strings“, von Expo beim Prebuild erzeugt). Die Antworten
// (Dialoge) wählen die Sprache zur Laufzeit.
import AppIntents
import Foundation
import TimelogNative

/// Deutsch oder Englisch nach der bevorzugten Sprache des Geräts (wie die App: en* = Englisch).
private func tr(_ de: String, _ en: String) -> String {
  (Locale.preferredLanguages.first ?? "de").lowercased().hasPrefix("en") ? en : de
}

@available(iOS 16.4, *)
struct WorkNetworkConnectedIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeitsnetz verbunden"
  static var description = IntentDescription(
    "Meldet TimeLog, dass das Gerät mit dem Arbeitsnetz verbunden ist. Für die Automation „WLAN verbunden“."
  )
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard TimelogShared.detectionEnabled else {
      let text = tr(
        "Netzwerkerkennung ist in TimeLog ausgeschaltet.",
        "Network detection is turned off in TimeLog.")
      return .result(dialog: "\(text)")
    }
    let gateways = await withCheckedContinuation { continuation in
      TimelogShared.currentGateways { continuation.resume(returning: $0) }
    }
    TimelogShared.connect(source: "shortcut", gateways: gateways)
    let text = tr("Arbeitsnetz gemeldet.", "Work network reported.")
    return .result(dialog: "\(text)")
  }
}

@available(iOS 16.4, *)
struct StartWorkIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeit beginnen"
  static var description = IntentDescription("Startet die Zeiterfassung in TimeLog.")
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    TimelogShared.manual("manual_start")
    let text = tr("Arbeit begonnen.", "Work started.")
    return .result(dialog: "\(text)")
  }
}

@available(iOS 16.4, *)
struct StopWorkIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeit beenden"
  static var description = IntentDescription("Beendet die Zeiterfassung in TimeLog.")
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    TimelogShared.manual("manual_end")
    let text = tr("Arbeit beendet.", "Work stopped.")
    return .result(dialog: "\(text)")
  }
}

@available(iOS 16.4, *)
struct TimelogShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartWorkIntent(),
      phrases: ["Arbeit beginnen mit \(.applicationName)", "Start work in \(.applicationName)"],
      shortTitle: "Arbeit beginnen",
      systemImageName: "play.circle"
    )
    AppShortcut(
      intent: StopWorkIntent(),
      phrases: ["Arbeit beenden mit \(.applicationName)", "Stop work in \(.applicationName)"],
      shortTitle: "Arbeit beenden",
      systemImageName: "stop.circle"
    )
    AppShortcut(
      intent: WorkNetworkConnectedIntent(),
      phrases: [
        "Arbeitsnetz verbunden in \(.applicationName)",
        "Work network connected in \(.applicationName)",
      ],
      shortTitle: "Arbeitsnetz verbunden",
      systemImageName: "wifi"
    )
  }
}

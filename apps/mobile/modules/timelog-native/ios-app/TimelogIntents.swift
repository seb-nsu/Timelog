// TimelogIntents.swift – App Intents im App-Target (das Config-Plugin plugins/withTimelog.js
// kopiert diese Datei beim Prebuild in das iOS-Projekt). App Intents müssen im Binary der App
// liegen, damit die Kurzbefehle-App sie findet.
//
// „Arbeitsnetz verbunden“ ist für die persönliche Automation gedacht:
// Kurzbefehle → Automation → WLAN → <Arbeits-WLAN> → „Sofort ausführen“.
// Der WLAN-Name bleibt in der Kurzbefehle-App; TimeLog erfährt ihn nie.
// Ungeprüft auf Gerät, siehe docs/MOBILE.md.
import AppIntents
import Foundation
import TimelogNative

@available(iOS 16.4, *)
struct WorkNetworkConnectedIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeitsnetz verbunden"
  static var description = IntentDescription(
    "Meldet TimeLog, dass das Gerät mit dem Arbeitsnetz verbunden ist. Für die Automation „WLAN verbunden“."
  )
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard TimelogShared.detectionEnabled else {
      return .result(dialog: "Netzwerkerkennung ist in TimeLog ausgeschaltet.")
    }
    let gateways = await withCheckedContinuation { continuation in
      TimelogShared.currentGateways { continuation.resume(returning: $0) }
    }
    TimelogShared.connect(source: "shortcut", gateways: gateways)
    return .result(dialog: "Arbeitsnetz gemeldet.")
  }
}

@available(iOS 16.4, *)
struct StartWorkIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeit beginnen"
  static var description = IntentDescription("Startet die Zeiterfassung in TimeLog.")
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    TimelogShared.manual("manual_start")
    return .result(dialog: "Arbeit begonnen.")
  }
}

@available(iOS 16.4, *)
struct StopWorkIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeit beenden"
  static var description = IntentDescription("Beendet die Zeiterfassung in TimeLog.")
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult & ProvidesDialog {
    TimelogShared.manual("manual_end")
    return .result(dialog: "Arbeit beendet.")
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
      phrases: ["Arbeitsnetz verbunden in \(.applicationName)"],
      shortTitle: "Arbeitsnetz verbunden",
      systemImageName: "wifi"
    )
  }
}

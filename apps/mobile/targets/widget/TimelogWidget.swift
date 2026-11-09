// TimelogWidget.swift – Startbildschirm-Widget: Status, Netto heute, Start/Stopp.
// Liest den von der App berechneten Zustand aus der App Group (TimelogShared.widget()).
// Die Arbeitszeit rechnet nur @timelog/rules in der App; das Widget zeigt sie an und
// erzeugt beim Tippen nur ein manual_start/manual_end-Ereignis.
import AppIntents
import SwiftUI
import WidgetKit

/// Deutsch oder Englisch nach der bevorzugten Sprache des Geräts (wie die App: en* = Englisch).
/// Die Texte im Widget selbst liefert die App bereits übersetzt; das hier gilt nur für
/// Platzhalter und die Beschreibung in der Widget-Galerie.
private func tr(_ de: String, _ en: String) -> String {
  (Locale.preferredLanguages.first ?? "de").lowercased().hasPrefix("en") ? en : de
}

struct ToggleWorkIntent: AppIntent {
  static var title: LocalizedStringResource = "Arbeit beginnen oder beenden"
  static var isDiscoverable: Bool = false

  func perform() async throws -> some IntentResult {
    TimelogShared.toggleFromWidget()
    return .result()
  }
}

struct WorkEntry: TimelineEntry {
  let date: Date
  let running: Bool
  let since: Date?
  let title: String
  let subtitle: String
  let startLabel: String
  let stopLabel: String

  static func load(at date: Date = Date()) -> WorkEntry {
    let w = TimelogShared.widget()
    return WorkEntry(
      date: date,
      running: (w["running"] as? Bool) ?? false,
      since: (w["since"] as? String).flatMap(TimelogShared.date),
      title: (w["title"] as? String) ?? "TimeLog",
      subtitle: (w["subtitle"] as? String) ?? "",
      startLabel: (w["startLabel"] as? String) ?? "Start",
      stopLabel: (w["stopLabel"] as? String) ?? tr("Stopp", "Stop")
    )
  }
}

struct WorkProvider: TimelineProvider {
  func placeholder(in context: Context) -> WorkEntry {
    WorkEntry(date: Date(), running: false, since: nil, title: "TimeLog", subtitle: "0:00",
              startLabel: "Start", stopLabel: tr("Stopp", "Stop"))
  }

  func getSnapshot(in context: Context, completion: @escaping (WorkEntry) -> Void) {
    completion(.load())
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WorkEntry>) -> Void) {
    // Die App lädt das Widget nach jeder Neuberechnung neu; zusätzlich alle 15 min.
    let next = Calendar.current.date(byAdding: .minute, value: 15, to: Date()) ?? Date()
    completion(Timeline(entries: [.load()], policy: .after(next)))
  }
}

struct TimelogWidgetView: View {
  let entry: WorkEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(entry.title)
        .font(.headline)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
      if entry.running, let since = entry.since {
        Text(since, style: .timer)
          .font(.title2.monospacedDigit())
          .accessibilityLabel(Text(entry.subtitle))
      } else {
        Text(entry.subtitle)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
      Button(intent: ToggleWorkIntent()) {
        Label(entry.running ? entry.stopLabel : entry.startLabel,
              systemImage: entry.running ? "stop.fill" : "play.fill")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .accessibilityLabel(Text(entry.running ? entry.stopLabel : entry.startLabel))
    }
    .containerBackground(for: .widget) { Color(.systemBackground) }
  }
}

@main
struct TimelogWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "TimelogWidget", provider: WorkProvider()) { entry in
      TimelogWidgetView(entry: entry)
    }
    .configurationDisplayName("TimeLog")
    .description(Text(tr("Arbeitszeit heute mit Start und Stopp.", "Today’s working time with start and stop.")))
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

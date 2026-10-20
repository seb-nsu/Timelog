// TimelogShared.swift – gemeinsamer Speicher in der App Group.
// Dieselbe Datei liegt unter targets/widget/TimelogShared.swift (Widget-Erweiterung); ein Jest-Test
// prüft, dass beide gleich sind. Gespeichert werden nur Ereignisse, Aktiv-Spannen, der
// Widget-Zustand und das Gateway des Arbeitsnetzes (nur lokal) – nie Koordinaten oder WLAN-Namen.
import Foundation
import Network

public enum TimelogShared {
  /// App Group aus Info.plist (`TimelogAppGroup`), sonst `group.<Bundle-ID der App>`.
  public static var groupId: String {
    if let value = Bundle.main.object(forInfoDictionaryKey: "TimelogAppGroup") as? String, !value.isEmpty {
      return value
    }
    var id = Bundle.main.bundleIdentifier ?? "de.timelog.mobile"
    if let range = id.range(of: ".widget", options: .backwards) { id.removeSubrange(range.lowerBound..<id.endIndex) }
    return "group.\(id)"
  }

  static var defaults: UserDefaults { UserDefaults(suiteName: groupId) ?? .standard }
  private static let lock = NSLock()

  /// Wird gesetzt, solange die App läuft (meldet neue Ereignisse an JS).
  public static var onChange: (() -> Void)?

  /// Nach so langer Funkstille gilt ein neues „verbunden“ als neue Sitzung (maxBreakMin).
  static let staleAfter: TimeInterval = 120 * 60

  // MARK: Zeit

  public static func iso(_ date: Date = Date()) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: date)
  }

  static func date(_ value: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }

  /// IANA-Zeitzone des Geräts zum Ereigniszeitpunkt.
  public static var timezone: String { TimeZone.current.identifier }

  // MARK: Einstellungen

  public static var detectionEnabled: Bool {
    get { defaults.bool(forKey: "detection") }
    set { defaults.set(newValue, forKey: "detection") }
  }

  public static var connected: Bool { defaults.bool(forKey: "connected") }

  // MARK: Ereignisse und Spannen

  private static func load(_ key: String) -> [[String: Any]] {
    guard let text = defaults.string(forKey: key), let data = text.data(using: .utf8),
          let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return list
  }

  private static func save(_ key: String, _ list: [[String: Any]]) {
    if let data = try? JSONSerialization.data(withJSONObject: list), let text = String(data: data, encoding: .utf8) {
      defaults.set(text, forKey: key)
    }
  }

  private static func event(_ type: String, _ source: String, _ ts: String) -> [String: Any] {
    ["id": UUID().uuidString.lowercased(), "type": type, "source": source, "ts": ts,
     "tz": timezone, "createdAt": iso()]
  }

  /// Start/Stopp (Widget, Kurzbefehl „Arbeit beginnen/beenden“): Quelle `user`, live.
  public static func manual(_ type: String) {
    lock.lock(); defer { lock.unlock() }
    var events = load("events")
    events.append(event(type, "user", iso()))
    save("events", events)
    onChange?()
  }

  /// Arbeitsnetz verbunden (Kurzbefehl oder Geofence betreten).
  public static func connect(source: String, gateways: [String] = []) {
    lock.lock(); defer { lock.unlock() }
    let now = Date()
    if connected, let end = openSpanEnd(), let endDate = date(end), now.timeIntervalSince(endDate) < staleAfter {
      extendLocked(iso(now))
      if !gateways.isEmpty { defaults.set(gateways, forKey: "gateways") }
      onChange?()
      return
    }
    if connected {
      // Kein Trennen gemeldet (Kurzbefehle kennen keinen Trennen-Auslöser): Ende = letzte Bestätigung
      lostLocked(at: openSpanEnd() ?? iso(now), source: defaults.string(forKey: "source") ?? source)
    }
    let ts = iso(now)
    var events = load("events")
    events.append(event("net_connected", source, ts))
    save("events", events)
    let spanId = UUID().uuidString.lowercased()
    var spans = load("spans")
    spans.append(["id": spanId, "start": ts, "end": ts, "open": true])
    save("spans", spans)
    defaults.set(true, forKey: "connected")
    defaults.set(spanId, forKey: "openSpan")
    defaults.set(source, forKey: "source")
    defaults.set(gateways, forKey: "gateways")
    onChange?()
  }

  /// Arbeitsnetz verlassen (Geofence verlassen oder Gateway weg).
  public static func lost(at: String? = nil, source: String? = nil) {
    lock.lock(); defer { lock.unlock() }
    guard connected else { return }
    lostLocked(at: at ?? iso(), source: source ?? defaults.string(forKey: "source") ?? "geofence")
    onChange?()
  }

  private static func lostLocked(at: String, source: String) {
    var events = load("events")
    events.append(event("net_lost", source, at))
    save("events", events)
    let id = defaults.string(forKey: "openSpan")
    let spans = load("spans").map { s -> [String: Any] in
      guard (s["id"] as? String) == id else { return s }
      var c = s
      if let end = c["end"] as? String, end < at { c["end"] = at }
      c["open"] = false
      return c
    }
    save("spans", spans)
    defaults.set(false, forKey: "connected")
    defaults.removeObject(forKey: "openSpan")
    defaults.removeObject(forKey: "gateways")
  }

  public static func extend(at: String) {
    lock.lock(); defer { lock.unlock() }
    extendLocked(at)
  }

  private static func extendLocked(_ at: String) {
    guard let id = defaults.string(forKey: "openSpan") else { return }
    let spans = load("spans").map { s -> [String: Any] in
      guard (s["id"] as? String) == id, let end = s["end"] as? String, end < at else { return s }
      var c = s
      c["end"] = at
      return c
    }
    save("spans", spans)
  }

  static func openSpanEnd() -> String? {
    guard let id = defaults.string(forKey: "openSpan") else { return nil }
    return load("spans").first { ($0["id"] as? String) == id }?["end"] as? String
  }

  /// Aktiv-Spanne bei App-Start und Widget-Refresh: gleiches Gateway → verlängern, sonst Ende
  /// bei der letzten Bestätigung. Ohne gemerktes Gateway (Geofence) nur verlängern, solange
  /// der Bereich nicht verlassen wurde.
  public static func refreshPresence(completion: (() -> Void)? = nil) {
    guard connected else { completion?(); return }
    let known = defaults.stringArray(forKey: "gateways") ?? []
    currentGateways { gateways in
      if known.isEmpty || !Set(known).isDisjoint(with: gateways) {
        if known.isEmpty && defaults.string(forKey: "source") == "shortcut" {
          // Ohne Gateway kein Beleg, dass das Netz noch da ist
        } else {
          extend(at: iso())
        }
      } else {
        lost(at: openSpanEnd())
      }
      completion?()
    }
  }

  /// IPv4-Gateways des aktuellen WLAN/LAN über NWPath (ohne Standortberechtigung).
  public static func currentGateways(_ done: @escaping ([String]) -> Void) {
    let monitor = NWPathMonitor()
    let queue = DispatchQueue(label: "timelog.path")
    var finished = false
    let finish: ([String]) -> Void = { list in
      queue.async {
        if finished { return }
        finished = true
        monitor.cancel()
        done(list)
      }
    }
    monitor.pathUpdateHandler = { path in
      guard path.status == .satisfied,
            path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) else {
        finish([])
        return
      }
      let list = path.gateways.compactMap { endpoint -> String? in
        if case let .hostPort(host, _) = endpoint, case let .ipv4(address) = host {
          return "\(address)".components(separatedBy: "%").first
        }
        return nil
      }
      finish(list)
    }
    monitor.start(queue: queue)
    queue.asyncAfter(deadline: .now() + 2) { finish([]) }
  }

  // MARK: Übergabe an JS

  public static func drainJSON() -> String {
    lock.lock(); defer { lock.unlock() }
    let spans = load("spans").filter { ($0["acked"] as? String) != ($0["end"] as? String) }
      .map { s -> [String: Any] in
        ["id": s["id"] ?? "", "start": s["start"] ?? "", "end": s["end"] ?? "", "open": s["open"] ?? false]
      }
    let body: [String: Any] = ["events": load("events"), "spans": spans]
    guard let data = try? JSONSerialization.data(withJSONObject: body),
          let text = String(data: data, encoding: .utf8) else { return "{\"events\":[],\"spans\":[]}" }
    return text
  }

  public static func acknowledge(eventIds: [String], spansJSON: String) {
    lock.lock(); defer { lock.unlock() }
    let ids = Set(eventIds)
    save("events", load("events").filter { !ids.contains(($0["id"] as? String) ?? "") })
    let acked = (try? JSONSerialization.jsonObject(with: Data(spansJSON.utf8)) as? [[String: String]]) ?? []
    var ends: [String: String] = [:]
    for a in acked { if let id = a["id"], let end = a["end"] { ends[id] = end } }
    let spans = load("spans").compactMap { s -> [String: Any]? in
      guard let id = s["id"] as? String, let end = ends[id], end == (s["end"] as? String) else { return s }
      if (s["open"] as? Bool) == true {
        var c = s
        c["acked"] = end
        return c
      }
      return nil
    }
    save("spans", spans)
  }

  // MARK: Widget

  public static func saveWidget(_ json: String) { defaults.set(json, forKey: "widget") }

  public static func widget() -> [String: Any] {
    guard let text = defaults.string(forKey: "widget"),
          let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { return [:] }
    return obj
  }

  /// Widget sofort umschalten; die App berechnet beim nächsten Start den echten Stand.
  public static func toggleFromWidget() {
    var w = widget()
    let running = (w["running"] as? Bool) ?? false
    manual(running ? "manual_end" : "manual_start")
    w["running"] = !running
    if running { w.removeValue(forKey: "since") } else { w["since"] = iso() }
    if let data = try? JSONSerialization.data(withJSONObject: w), let text = String(data: data, encoding: .utf8) {
      saveWidget(text)
    }
  }
}

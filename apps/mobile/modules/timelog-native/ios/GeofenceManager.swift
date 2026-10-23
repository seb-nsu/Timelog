// GeofenceManager.swift – Arbeitsende über Geofence (opt-in, „Immer“-Standort).
// Standard ist CLMonitor (iOS 17+); da dieser laut Entwicklerberichten seltener weckt, gibt es
// den Rückfall CLCircularRegion (auch für iOS 16). Den Mittelpunkt hält nur das System
// (CLMonitor bzw. monitoredRegions); die App speichert und sendet keine Koordinaten, sondern nur
// „betreten“/„verlassen“ als net_connected/net_lost mit Quelle `geofence`.
import CoreLocation
import Foundation

final class GeofenceManager: NSObject, CLLocationManagerDelegate, @unchecked Sendable {
  static let shared = GeofenceManager()

  private static let monitorName = "TimelogWork"
  private static let conditionId = "work"
  private static let regionId = "timelog.work"

  private let manager = CLLocationManager()
  private var monitorTask: Task<Void, Never>?
  private var authContinuation: CheckedContinuation<CLAuthorizationStatus, Never>?
  private var locationContinuation: CheckedContinuation<CLLocation?, Never>?

  private var defaults: UserDefaults { TimelogShared.defaults }

  var engine: String? {
    get { defaults.string(forKey: "geofenceEngine") }
    set { defaults.set(newValue, forKey: "geofenceEngine") }
  }

  override init() {
    super.init()
    manager.delegate = self
  }

  /// Beim Start der App (auch Hintergrund-Start durch Core Location) sofort wieder lauschen.
  func startAtLaunch() {
    guard let engine else { return }
    if engine == "monitor", #available(iOS 17.0, *) {
      listenMonitor()
    }
    // Für CLCircularRegion genügt der Delegate; das System liefert das Ereignis nach dem Start.
  }

  // MARK: Status

  func permission() -> String {
    switch manager.authorizationStatus {
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "whenInUse"
    case .denied, .restricted: return "denied"
    case .notDetermined: return "undetermined"
    @unknown default: return "undetermined"
    }
  }

  func status() -> [String: Any] {
    let inside = defaults.object(forKey: "geofenceInside") as? Bool
    return [
      "active": engine != nil,
      "engine": engine ?? NSNull(),
      "permission": CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) ? permission() : "unavailable",
      "inside": inside ?? NSNull(),
    ]
  }

  // MARK: Einrichten

  /// Erst „Beim Verwenden“, dann „Immer“ anfragen, den aktuellen Ort einmal bestimmen und
  /// als Bereich überwachen. Der Ort verlässt diese Funktion nicht.
  func enableHere(radius: Double, engine requested: String) async -> [String: Any] {
    if manager.authorizationStatus == .notDetermined {
      _ = await requestAuthorization { $0.requestWhenInUseAuthorization() }
    }
    if manager.authorizationStatus == .authorizedWhenInUse {
      _ = await requestAuthorization { $0.requestAlwaysAuthorization() }
    }
    guard manager.authorizationStatus == .authorizedAlways else { return status() }
    guard let location = await currentLocation() else { return status() }

    await disable()
    let radius = min(max(radius, 100), manager.maximumRegionMonitoringDistance)
    if requested == "monitor", #available(iOS 17.0, *) {
      let monitor = await CLMonitor(Self.monitorName)
      let condition = CLMonitor.CircularGeographicCondition(center: location.coordinate, radius: radius)
      // Beim Einrichten steht man am Arbeitsort.
      await monitor.add(condition, identifier: Self.conditionId, assuming: .satisfied)
      engine = "monitor"
      listenMonitor()
    } else {
      let region = CLCircularRegion(center: location.coordinate, radius: radius, identifier: Self.regionId)
      region.notifyOnEntry = true
      region.notifyOnExit = true
      manager.startMonitoring(for: region)
      engine = "region"
    }
    defaults.set(true, forKey: "geofenceInside")
    return status()
  }

  func disable() async {
    monitorTask?.cancel()
    monitorTask = nil
    if #available(iOS 17.0, *) {
      let monitor = await CLMonitor(Self.monitorName)
      await monitor.remove(Self.conditionId)
    }
    for region in manager.monitoredRegions where region.identifier == Self.regionId {
      manager.stopMonitoring(for: region)
    }
    engine = nil
    defaults.removeObject(forKey: "geofenceInside")
  }

  // MARK: Ereignisse

  private func handle(inside: Bool) {
    let before = defaults.object(forKey: "geofenceInside") as? Bool
    defaults.set(inside, forKey: "geofenceInside")
    guard before != inside, engine != nil else { return }
    if inside {
      TimelogShared.connect(source: "geofence")
    } else {
      TimelogShared.lost(source: "geofence")
    }
  }

  @available(iOS 17.0, *)
  private func listenMonitor() {
    guard monitorTask == nil else { return }
    monitorTask = Task { [weak self] in
      let monitor = await CLMonitor(Self.monitorName)
      do {
        for try await event in await monitor.events where event.identifier == Self.conditionId {
          switch event.state {
          case .satisfied: self?.handle(inside: true)
          case .unsatisfied: self?.handle(inside: false)
          default: break
          }
        }
      } catch {
        // Ereignisfolge beendet; beim nächsten Start neu
      }
      self?.monitorTask = nil
    }
  }

  func locationManager(_ manager: CLLocationManager, didEnterRegion region: CLRegion) {
    if region.identifier == Self.regionId { handle(inside: true) }
  }

  func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
    if region.identifier == Self.regionId { handle(inside: false) }
  }

  // MARK: Berechtigung und einmaliger Ort

  private func requestAuthorization(_ ask: (CLLocationManager) -> Void) async -> CLAuthorizationStatus {
    await withCheckedContinuation { continuation in
      authContinuation = continuation
      ask(manager)
      // Ohne Antwort (z. B. „Immer“ wird erst später angeboten) nach 30 s weiter
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
        self?.resumeAuth()
      }
    }
  }

  private func resumeAuth() {
    authContinuation?.resume(returning: manager.authorizationStatus)
    authContinuation = nil
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus != .notDetermined { resumeAuth() }
  }

  private func currentLocation() async -> CLLocation? {
    await withCheckedContinuation { continuation in
      locationContinuation = continuation
      manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
      manager.requestLocation()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    locationContinuation?.resume(returning: locations.last)
    locationContinuation = nil
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    locationContinuation?.resume(returning: nil)
    locationContinuation = nil
  }
}

// TimelogNativeModule.swift – Brücke zu JS (Expo Modules API).
// iOS kennt keinen Netzwerk-Callback für beendete Apps: Beginn kommt über den Kurzbefehl
// „Arbeitsnetz verbunden“ (App Intent im App-Target, siehe ios-app/), Ende über Geofence (opt-in)
// oder den Laptop. Die Arbeitszeit berechnet ausschließlich @timelog/rules in JS.
import ExpoModulesCore
import Network
import WidgetKit

public class TimelogNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TimelogNative")

    Events("onChange")

    OnCreate {
      TimelogShared.onChange = { [weak self] in
        self?.sendEvent("onChange", [:])
      }
      TimelogShared.refreshPresence()
    }

    OnDestroy {
      TimelogShared.onChange = nil
    }

    OnAppEntersForeground {
      TimelogShared.refreshPresence()
    }

    AsyncFunction("capabilities") { () -> [String: Any] in
      [
        "platform": "ios",
        "networkDetection": false,
        "ssidOption": false,
        "geofence": CLLocationManagerAvailability.monitoring,
        "shortcuts": true,
        "widget": true,
        "batteryOptimization": false,
      ]
    }

    AsyncFunction("configure") { (json: String) in
      let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
      let enabled = (obj["detection"] as? Bool) ?? false
      TimelogShared.detectionEnabled = enabled
      if !enabled { TimelogShared.lost() }
    }

    AsyncFunction("status") { () -> [String: Any] in
      [
        "armed": TimelogShared.detectionEnabled || GeofenceManager.shared.engine != nil,
        "connected": TimelogShared.connected,
        "lastCheck": TimelogShared.defaults.string(forKey: "lastCheck") ?? NSNull(),
      ]
    }

    // Auf iOS keine Netzwerk-Kennung: NWPath liefert Gateways, aber keine DNS-Server oder
    // Suchdomänen; erkannt wird über den Kurzbefehl, dessen WLAN der Nutzer selbst wählt.
    AsyncFunction("currentNetwork") { (promise: Promise) in
      TimelogShared.currentGateways { gateways in
        promise.resolve([
          "fingerprint": NSNull(),
          "transport": gateways.isEmpty ? "none" : "wifi",
          "ssid": NSNull(),
          "bssid": NSNull(),
          "matchedNetworkId": NSNull(),
        ] as [String: Any])
      }
    }

    AsyncFunction("checkNow") { (promise: Promise) in
      TimelogShared.refreshPresence {
        TimelogShared.defaults.set(TimelogShared.iso(), forKey: "lastCheck")
        promise.resolve(nil)
      }
    }

    AsyncFunction("drain") { () -> String in
      TimelogShared.drainJSON()
    }

    AsyncFunction("acknowledge") { (eventIds: [String], spansJson: String) in
      TimelogShared.acknowledge(eventIds: eventIds, spansJSON: spansJson)
    }

    AsyncFunction("requestSsidPermission") { () -> String in
      "unavailable"
    }

    AsyncFunction("isIgnoringBatteryOptimizations") { () -> Bool in true }
    AsyncFunction("openBatterySettings") { () in }
    AsyncFunction("manufacturer") { () -> String in "apple" }

    AsyncFunction("geofenceStatus") { () -> [String: Any] in
      GeofenceManager.shared.status()
    }.runOnQueue(.main)

    AsyncFunction("enableGeofenceHere") { (radius: Int, engine: String) async -> [String: Any] in
      await GeofenceManager.shared.enableHere(radius: Double(radius), engine: engine)
    }.runOnQueue(.main)

    AsyncFunction("disableGeofence") { () async in
      await GeofenceManager.shared.disable()
    }.runOnQueue(.main)

    AsyncFunction("updateWidget") { (json: String) in
      TimelogShared.saveWidget(json)
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}

import CoreLocation

enum CLLocationManagerAvailability {
  static var monitoring: Bool { CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) }
}

package de.timelog.mobile.detect

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import de.timelog.mobile.detect.widget.TimelogWidget
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Brücke zu JS (Expo Modules API). Fachliche Berechnung passiert ausschließlich in TypeScript. */
class TimelogNativeModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("TimelogNative")

    Events("onChange")

    OnCreate {
      Detector.listener = { sendEvent("onChange", emptyMap<String, Any>()) }
      Detector.arm(context)
      Detector.startLiveCallback(context)
    }

    OnDestroy {
      Detector.listener = null
      appContext.reactContext?.let { Detector.stopLiveCallback(it) }
    }

    OnActivityEntersForeground {
      Detector.evaluate(context, Detector.Reason.PERIODIC)
    }

    AsyncFunction("capabilities") {
      mapOf(
        "platform" to "android",
        "networkDetection" to true,
        "ssidOption" to Detector.ssidOptionInBuild(context),
        "geofence" to false,
        "shortcuts" to false,
        "widget" to true,
        "batteryOptimization" to true,
      )
    }

    AsyncFunction("configure") { json: String ->
      DetectorStore(context).saveConfig(json)
      Detector.arm(context)
      Detector.evaluate(context, Detector.Reason.PERIODIC)
    }

    AsyncFunction("status") {
      val state = DetectorStore(context).state()
      mapOf(
        "armed" to Detector.isArmed(context),
        "connected" to state.connected,
        "lastCheck" to state.lastCheck,
      )
    }

    AsyncFunction("currentNetwork") {
      val c = Detector.current(context)
      mapOf(
        "fingerprint" to c.fingerprint,
        "transport" to c.transport,
        "ssid" to c.ssid,
        "bssid" to c.bssid,
        "matchedNetworkId" to c.match?.networkId,
      )
    }

    AsyncFunction("checkNow") {
      Detector.evaluate(context, Detector.Reason.MANUAL)
    }

    AsyncFunction("drain") {
      DetectorStore(context).drainJson()
    }

    AsyncFunction("acknowledge") { eventIds: List<String>, spansJson: String ->
      DetectorStore(context).acknowledge(eventIds, spansJson)
    }

    // Nur wenn der Build die Option „WLAN-Name“ enthält (Standortberechtigung im Manifest).
    AsyncFunction("requestSsidPermission") { promise: Promise ->
      val permissions = appContext.permissions
      if (permissions == null || !Detector.ssidOptionInBuild(context)) {
        promise.resolve("unavailable")
        return@AsyncFunction
      }
      permissions.askForPermissions(
        PermissionsResponseListener { _ ->
          if (!Detector.hasLocationPermission(context)) {
            promise.resolve("denied")
          } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            permissions.isPermissionPresentInManifest(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
          ) {
            // Seit Android 11 eigener Schritt; das System öffnet dafür die Einstellungen.
            permissions.askForPermissions(
              PermissionsResponseListener { _ ->
                val bg = permissions.hasGrantedPermissions(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                promise.resolve(if (bg) "granted" else "denied")
              },
              Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            )
          } else {
            promise.resolve("granted")
          }
        },
        Manifest.permission.ACCESS_FINE_LOCATION,
      )
    }

    AsyncFunction("isIgnoringBatteryOptimizations") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    AsyncFunction("openBatterySettings") {
      // Liste „Akkuoptimierung“; ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS ist bei Google Play
      // nur für wenige App-Arten erlaubt und wird deshalb nicht benutzt.
      val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
        .setData(android.net.Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      runCatching { context.startActivity(intent) }.onFailure { context.startActivity(fallback) }
    }

    AsyncFunction("manufacturer") {
      Build.MANUFACTURER.lowercase()
    }

    // Geofence gibt es auf Android im MVP nicht (Produktkonzept: „später“).
    AsyncFunction("geofenceStatus") {
      mapOf("active" to false, "engine" to null, "permission" to "unavailable", "inside" to null)
    }

    AsyncFunction("enableGeofenceHere") { _: Int, _: String ->
      mapOf("active" to false, "engine" to null, "permission" to "unavailable", "inside" to null)
    }

    AsyncFunction("disableGeofence") { }

    AsyncFunction("updateWidget") Coroutine { json: String ->
      DetectorStore(context).saveWidget(json)
      TimelogWidget.refresh(context)
    }
  }
}

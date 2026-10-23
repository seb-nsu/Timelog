package de.timelog.mobile.detect

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Base64
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.net.Inet4Address
import java.util.concurrent.TimeUnit

/**
 * Erkennung des Arbeitsnetzes ohne Standortberechtigung.
 *
 * - `registerNetworkCallback(request, PendingIntent)`: Android sendet den Intent, sobald ein
 *   passendes Netz verfügbar ist – auch wenn die App beendet ist (laut Doku nur bei „verfügbar“).
 * - WorkManager prüft alle 15 Minuten: Netz noch da → Aktiv-Spanne verlängern; weg → `net_lost`
 *   zum Zeitpunkt der letzten Bestätigung (die genaue Zeit ist unbekannt).
 * - Solange der Prozess läuft, liefert ein normaler NetworkCallback den genauen Trennzeitpunkt.
 *
 * Logs enthalten keine Kennungen, Adressen oder Netznamen.
 */
object Detector {
  private const val TAG = "TimelogDetector"
  private const val PERIODIC = "timelog-network-check"
  private const val SETTLE = "timelog-network-settle"
  private const val REQUEST_CODE = 4711

  /** Meldet JS, dass neue Ereignisse warten (nur solange die App läuft). */
  @Volatile var listener: (() -> Unit)? = null
  private var liveCallback: ConnectivityManager.NetworkCallback? = null

  data class Match(val networkId: String, val source: String)

  data class Current(
    val fingerprint: String?,
    val transport: String,
    val ssid: String?,
    val bssid: String?,
    val match: Match?,
  )

  private fun cm(context: Context) =
    context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  private fun request(): NetworkRequest =
    NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
      .build()

  private fun pendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, NetworkReceiver::class.java).setAction(NetworkReceiver.ACTION)
    // Mutable: Android ergänzt EXTRA_NETWORK. Der Intent ist explizit (eigene Klasse).
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags)
  }

  /** Callback und 15-Minuten-Prüfung je nach Einstellung an- oder abmelden. */
  fun arm(context: Context) {
    val config = DetectorStore(context).config()
    val work = WorkManager.getInstance(context)
    if (config.detection && config.networks.isNotEmpty()) {
      try {
        // Gleicher PendingIntent ersetzt eine frühere Anmeldung (Intent.filterEquals).
        cm(context).registerNetworkCallback(request(), pendingIntent(context))
      } catch (e: RuntimeException) {
        Log.w(TAG, "registerNetworkCallback fehlgeschlagen: ${e.javaClass.simpleName}")
      }
      work.enqueueUniquePeriodicWork(
        PERIODIC,
        ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES).build(),
      )
    } else {
      runCatching { cm(context).unregisterNetworkCallback(pendingIntent(context)) }
      work.cancelUniqueWork(PERIODIC)
      if (DetectorStore(context).state().connected) {
        // Automatik abgeschaltet: offenes Intervall sauber beenden
        DetectorStore(context).lost(DetectorStore.nowIso(), DetectorStore.timezone())
        listener?.invoke()
      }
    }
  }

  fun isArmed(context: Context): Boolean {
    val config = DetectorStore(context).config()
    return config.detection && config.networks.isNotEmpty()
  }

  /** Solange die App läuft: genauer Zeitpunkt beim Trennen. */
  fun startLiveCallback(context: Context) {
    if (liveCallback != null) return
    val app = context.applicationContext
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        evaluate(app, Reason.CALLBACK)
      }

      override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
        evaluate(app, Reason.CALLBACK)
      }

      override fun onLost(network: Network) {
        evaluate(app, Reason.LOST)
      }
    }
    runCatching { cm(app).registerNetworkCallback(request(), cb) }.onSuccess { liveCallback = cb }
  }

  fun stopLiveCallback(context: Context) {
    val cb = liveCallback ?: return
    runCatching { cm(context.applicationContext).unregisterNetworkCallback(cb) }
    liveCallback = null
  }

  enum class Reason { CALLBACK, LOST, PERIODIC, MANUAL }

  /** Aktuellen Zustand mit den hinterlegten Netzen vergleichen und Ereignisse erzeugen. */
  @Synchronized
  fun evaluate(context: Context, reason: Reason) {
    val store = DetectorStore(context)
    val config = store.config()
    val now = DetectorStore.nowIso()
    val tz = DetectorStore.timezone()
    val state = store.state()
    if (!config.detection) {
      store.setLastCheck(now)
      return
    }
    val match = current(context, config).match
    when {
      match != null && !state.connected -> {
        store.connected(now, match.source, match.networkId, tz)
        listener?.invoke()
      }
      match != null && match.networkId != state.networkId -> {
        // anderes Arbeitsnetz: altes Intervall beenden, neues beginnen
        store.lost(now, tz)
        store.connected(now, match.source, match.networkId, tz)
        listener?.invoke()
      }
      match != null -> store.extend(now)
      state.connected -> {
        val at = if (reason == Reason.LOST || reason == Reason.MANUAL) now else store.openSpanEnd() ?: now
        store.lost(at, tz)
        listener?.invoke()
      }
      reason == Reason.CALLBACK -> scheduleSettleCheck(context)
    }
    store.setLastCheck(now)
  }

  /**
   * Direkt nach „verfügbar“ fehlen manchmal noch DNS oder Adressen (DHCP läuft). Dann nach
   * einer Minute erneut prüfen.
   */
  private fun scheduleSettleCheck(context: Context) {
    WorkManager.getInstance(context).enqueueUniqueWork(
      SETTLE,
      ExistingWorkPolicy.REPLACE,
      OneTimeWorkRequestBuilder<CheckWorker>().setInitialDelay(1, TimeUnit.MINUTES).build(),
    )
  }

  /** Aktuelles WLAN/LAN mit Kennung und ggf. Treffer. */
  fun current(context: Context, config: DetectorStore.Config = DetectorStore(context).config()): Current {
    val cm = cm(context)
    val candidates = buildList {
      cm.activeNetwork?.let { add(it) }
      @Suppress("DEPRECATION")
      cm.allNetworks.forEach { if (it !in this) add(it) }
    }
    var fallback: Current? = null
    for (network in candidates) {
      val caps = cm.getNetworkCapabilities(network) ?: continue
      val transport = when {
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
        else -> continue
      }
      val lp = cm.getLinkProperties(network) ?: continue
      val fingerprint = NetworkFingerprint.of(linkInfo(lp))
      val (ssid, bssid) = if (transport == "wifi" && config.ssid) wifiName(context) else null to null
      val result = Current(fingerprint, transport, ssid, bssid, match(config, fingerprint, ssid, bssid, transport))
      if (result.match != null) return result
      if (fallback == null) fallback = result
    }
    return fallback ?: Current(null, "none", null, null, null)
  }

  fun linkInfo(lp: LinkProperties): LinkInfo = LinkInfo(
    gatewayMac = null, // seit Android 10 nicht lesbar (/proc/net gesperrt)
    gateways = lp.routes
      .filter { it.isDefaultRoute && it.gateway is Inet4Address }
      .mapNotNull { it.gateway?.hostAddress },
    addresses = lp.linkAddresses
      .filter { it.address is Inet4Address }
      .mapNotNull { la -> la.address.hostAddress?.let { LinkAddress(it, la.prefixLength) } },
    dnsServers = lp.dnsServers.filterIsInstance<Inet4Address>().mapNotNull { it.hostAddress },
    domains = lp.domains,
  )

  private fun keyFor(config: DetectorStore.Config, scope: String): ByteArray? {
    val b64 = if (scope == "org") config.orgKey else config.userKey
    if (b64.isNullOrEmpty()) return null
    return runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()
  }

  private fun match(
    config: DetectorStore.Config,
    fingerprint: String?,
    ssid: String?,
    bssid: String?,
    transport: String,
  ): Match? {
    // Kennung zuerst: braucht keine Berechtigung und deckt auch LAN ab.
    if (fingerprint != null) {
      for (n in config.networks) {
        val want = n.fingerprintHmac ?: continue
        val key = keyFor(config, n.scope) ?: continue
        if (NetworkFingerprint.hmacHex(key, fingerprint) == want) {
          return Match(n.id, if (transport == "ethernet") "lan" else "wifi")
        }
      }
    }
    if (ssid != null) {
      for (n in config.networks) {
        if (n.kind != "ssid" || n.ssid != ssid) continue
        val want = n.bssidHmac
        val ok = when {
          want == null -> true
          bssid == null -> false
          else -> keyFor(config, n.scope)?.let { NetworkFingerprint.hmacHex(it, bssid) == want } ?: false
        }
        if (ok) return Match(n.id, "wifi")
      }
    }
    return null
  }

  fun hasLocationPermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

  /** Ob der Build die Standortberechtigung überhaupt anfragt (Option „WLAN-Name“). */
  fun ssidOptionInBuild(context: Context): Boolean = runCatching {
    @Suppress("DEPRECATION")
    val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
    info.requestedPermissions?.contains(Manifest.permission.ACCESS_FINE_LOCATION) == true
  }.getOrDefault(false)

  /**
   * WLAN-Name und BSSID nur mit aktivierter Option und Standortfreigabe. Der Name wird nur mit
   * hinterlegten Netzen verglichen und nirgends gespeichert.
   */
  @SuppressLint("MissingPermission")
  private fun wifiName(context: Context): Pair<String?, String?> {
    if (!hasLocationPermission(context)) return null to null
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    @Suppress("DEPRECATION")
    val info = wifi.connectionInfo ?: return null to null
    @Suppress("DEPRECATION")
    val ssid = info.ssid?.removePrefix("\"")?.removeSuffix("\"")
      ?.takeIf { it.isNotEmpty() && it != "<unknown ssid>" }
    @Suppress("DEPRECATION")
    val bssid = info.bssid?.takeIf { it != "02:00:00:00:00:00" }
    return ssid to bssid
  }
}

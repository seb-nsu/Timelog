package de.timelog.mobile.detect

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Kleiner Speicher des nativen Teils (app-private SharedPreferences). Hält Ereignisse und
 * Aktiv-Spannen, bis die App sie abholt (`drain`/`acknowledge`), dazu die Konfiguration aus JS
 * (nur HMACs und HMAC-Schlüssel, keine Klartext-Kennungen) und den Widget-Zustand.
 * Gespeichert werden weder Koordinaten noch WLAN-Namen fremder Netze.
 */
class DetectorStore(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences("timelog_detector", Context.MODE_PRIVATE)

  data class WorkNetwork(
    val id: String,
    val scope: String,
    val kind: String,
    val ssid: String?,
    val bssidHmac: String?,
    val fingerprintHmac: String?,
  )

  data class Config(
    val detection: Boolean,
    val ssid: Boolean,
    val networks: List<WorkNetwork>,
    val userKey: String,
    val orgKey: String?,
  )

  data class State(
    val connected: Boolean,
    val networkId: String?,
    val openSpanId: String?,
    val lastCheck: String?,
  )

  // ── Konfiguration ──────────────────────────────────────────────────────────

  fun saveConfig(json: String) = synchronized(LOCK) {
    prefs.edit().putString(KEY_CONFIG, json).commit()
  }

  fun config(): Config = synchronized(LOCK) {
    val o = prefs.getString(KEY_CONFIG, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
      ?: return Config(false, false, emptyList(), "", null)
    val list = o.optJSONArray("networks") ?: JSONArray()
    val networks = (0 until list.length()).map {
      val n = list.getJSONObject(it)
      WorkNetwork(
        id = n.getString("id"),
        scope = n.optString("scope", "user"),
        kind = n.optString("kind", "fingerprint"),
        ssid = n.optStringOrNull("ssid"),
        bssidHmac = n.optStringOrNull("bssidHmac"),
        fingerprintHmac = n.optStringOrNull("fingerprintHmac"),
      )
    }
    val keys = o.optJSONObject("keys") ?: JSONObject()
    Config(
      detection = o.optBoolean("detection", false),
      ssid = o.optBoolean("ssid", false),
      networks = networks,
      userKey = keys.optString("user", ""),
      orgKey = keys.optStringOrNull("org"),
    )
  }

  // ── Zustand ────────────────────────────────────────────────────────────────

  fun state(): State = synchronized(LOCK) {
    State(
      connected = prefs.getBoolean(KEY_CONNECTED, false),
      networkId = prefs.getString(KEY_NETWORK, null),
      openSpanId = prefs.getString(KEY_OPEN_SPAN, null),
      lastCheck = prefs.getString(KEY_LAST_CHECK, null),
    )
  }

  fun setLastCheck(at: String) = synchronized(LOCK) {
    prefs.edit().putString(KEY_LAST_CHECK, at).commit()
  }

  /** Verbunden: `net_connected` und neue offene Spanne. */
  fun connected(at: String, source: String, networkId: String, tz: String) = synchronized(LOCK) {
    val spanId = UUID.randomUUID().toString()
    val events = events()
    events.put(event("net_connected", source, at, tz, networkId))
    val spans = spans()
    spans.put(JSONObject().put("id", spanId).put("start", at).put("end", at).put("open", true))
    prefs.edit()
      .putString(KEY_EVENTS, events.toString())
      .putString(KEY_SPANS, spans.toString())
      .putBoolean(KEY_CONNECTED, true)
      .putString(KEY_NETWORK, networkId)
      .putString(KEY_SOURCE, source)
      .putString(KEY_OPEN_SPAN, spanId)
      .commit()
  }

  /** Noch verbunden: offene Spanne bis `at` verlängern. */
  fun extend(at: String) = synchronized(LOCK) {
    val id = prefs.getString(KEY_OPEN_SPAN, null) ?: return@synchronized
    val spans = spans()
    for (i in 0 until spans.length()) {
      val s = spans.getJSONObject(i)
      if (s.getString("id") == id && s.getString("end") < at) s.put("end", at)
    }
    prefs.edit().putString(KEY_SPANS, spans.toString()).commit()
  }

  /** Ende der offenen Spanne = letzte Bestätigung, dass das Netz noch da war. */
  fun openSpanEnd(): String? = synchronized(LOCK) {
    val id = prefs.getString(KEY_OPEN_SPAN, null) ?: return@synchronized null
    val spans = spans()
    (0 until spans.length()).map { spans.getJSONObject(it) }.firstOrNull { it.getString("id") == id }
      ?.getString("end")
  }

  /** Getrennt: `net_lost` zum Zeitpunkt `at`, offene Spanne dort schließen. */
  fun lost(at: String, tz: String) = synchronized(LOCK) {
    val events = events()
    val source = prefs.getString(KEY_SOURCE, "wifi") ?: "wifi"
    events.put(event("net_lost", source, at, tz, prefs.getString(KEY_NETWORK, null)))
    val id = prefs.getString(KEY_OPEN_SPAN, null)
    val spans = spans()
    for (i in 0 until spans.length()) {
      val s = spans.getJSONObject(i)
      if (s.getString("id") == id) {
        if (s.getString("end") < at) s.put("end", at)
        s.put("open", false)
      }
    }
    prefs.edit()
      .putString(KEY_EVENTS, events.toString())
      .putString(KEY_SPANS, spans.toString())
      .putBoolean(KEY_CONNECTED, false)
      .remove(KEY_NETWORK)
      .remove(KEY_OPEN_SPAN)
      .commit()
  }

  /** Start/Stopp aus dem Widget (Quelle `user`, live). */
  fun manual(type: String, at: String, tz: String) = synchronized(LOCK) {
    val events = events()
    events.put(event(type, "user", at, tz, null))
    prefs.edit().putString(KEY_EVENTS, events.toString()).commit()
  }

  // ── Übergabe an JS ─────────────────────────────────────────────────────────

  fun drainJson(): String = synchronized(LOCK) {
    val spans = spans()
    val pending = JSONArray()
    for (i in 0 until spans.length()) {
      val s = spans.getJSONObject(i)
      if (s.optString("acked", "") != s.getString("end")) {
        pending.put(JSONObject().put("id", s.getString("id")).put("start", s.getString("start"))
          .put("end", s.getString("end")).put("open", s.getBoolean("open")))
      }
    }
    JSONObject().put("events", events()).put("spans", pending).toString()
  }

  fun acknowledge(eventIds: List<String>, spansJson: String) = synchronized(LOCK) {
    val ids = eventIds.toSet()
    val events = events()
    val keep = JSONArray()
    for (i in 0 until events.length()) {
      val e = events.getJSONObject(i)
      if (e.getString("id") !in ids) keep.put(e)
    }
    val acked = JSONArray(spansJson)
    val ackedEnds = (0 until acked.length()).associate {
      val a = acked.getJSONObject(it)
      a.getString("id") to a.getString("end")
    }
    val spans = spans()
    val keepSpans = JSONArray()
    for (i in 0 until spans.length()) {
      val s = spans.getJSONObject(i)
      val end = ackedEnds[s.getString("id")]
      when {
        end == null -> keepSpans.put(s)
        end != s.getString("end") -> keepSpans.put(s) // inzwischen verlängert
        s.getBoolean("open") -> keepSpans.put(s.put("acked", end))
        else -> Unit // abgeschlossen und abgeholt
      }
    }
    prefs.edit().putString(KEY_EVENTS, keep.toString()).putString(KEY_SPANS, keepSpans.toString()).commit()
  }

  // ── Widget ─────────────────────────────────────────────────────────────────

  fun saveWidget(json: String) = synchronized(LOCK) {
    prefs.edit().putString(KEY_WIDGET, json).commit()
  }

  fun widget(): JSONObject? = synchronized(LOCK) {
    prefs.getString(KEY_WIDGET, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
  }

  private fun events(): JSONArray =
    prefs.getString(KEY_EVENTS, null)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: JSONArray()

  private fun spans(): JSONArray =
    prefs.getString(KEY_SPANS, null)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: JSONArray()

  private fun event(type: String, source: String, at: String, tz: String, networkId: String?): JSONObject {
    val o = JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("type", type)
      .put("source", source)
      .put("ts", at)
      .put("tz", tz)
      .put("createdAt", nowIso())
    if (networkId != null) o.put("networkId", networkId)
    return o
  }

  companion object {
    private val LOCK = Any()
    private const val KEY_CONFIG = "config"
    private const val KEY_EVENTS = "events"
    private const val KEY_SPANS = "spans"
    private const val KEY_CONNECTED = "connected"
    private const val KEY_NETWORK = "networkId"
    private const val KEY_SOURCE = "source"
    private const val KEY_OPEN_SPAN = "openSpan"
    private const val KEY_LAST_CHECK = "lastCheck"
    private const val KEY_WIDGET = "widget"

    /** UTC im Format von `Date.toISOString()`; ohne java.time, damit es ab API 24 läuft. */
    fun nowIso(): String = iso(Date())

    fun iso(date: Date): String {
      val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
      f.timeZone = TimeZone.getTimeZone("UTC")
      return f.format(date)
    }

    /** IANA-Zeitzone des Geräts, z. B. Europe/Berlin. */
    fun timezone(): String = TimeZone.getDefault().id
  }
}

private fun JSONObject.optStringOrNull(key: String): String? =
  if (has(key) && !isNull(key)) getString(key) else null

package de.timelog.mobile.detect

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.util.Base64

/** Gleiche Testfälle wie test/fingerprint.test.ts (Jest). */
class NetworkFingerprintTest {
  // Gradle startet Unit-Tests im Modulverzeichnis (android/); die Datei liegt eine Ebene höher.
  private val vectors: JSONObject by lazy {
    JSONObject(File("../fingerprint-vectors.json").readText())
  }

  private fun strings(a: JSONArray): List<String> = (0 until a.length()).map { a.getString(it) }

  private fun link(o: JSONObject) = LinkInfo(
    gatewayMac = if (o.isNull("gatewayMac")) null else o.optString("gatewayMac", "").ifEmpty { null },
    gateways = strings(o.getJSONArray("gateways")),
    addresses = o.getJSONArray("addresses").let { a ->
      (0 until a.length()).map {
        val x = a.getJSONObject(it)
        LinkAddress(x.getString("address"), x.getInt("prefixLength"))
      }
    },
    dnsServers = strings(o.getJSONArray("dnsServers")),
    domains = if (o.isNull("domains")) null else o.getString("domains"),
  )

  @Test
  fun kennungWieReferenz() {
    val cases = vectors.getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val expected = if (c.isNull("fingerprint")) null else c.getString("fingerprint")
      assertEquals(c.getString("name"), expected, NetworkFingerprint.of(link(c.getJSONObject("link"))))
    }
  }

  @Test
  fun hmacWieBackend() {
    val key = Base64.getDecoder().decode(vectors.getString("hmacKey"))
    val list = vectors.getJSONArray("hmac")
    for (i in 0 until list.length()) {
      val v = list.getJSONObject(i)
      assertEquals(v.getString("hex"), NetworkFingerprint.hmacHex(key, v.getString("value")))
    }
  }
}

package de.timelog.mobile.detect

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Netzwerk-Kennung ohne Standortberechtigung. Gleiches Format wie die TypeScript-Referenz
 * `modules/timelog-native/src/fingerprint.ts`; beide prüfen sich gegen fingerprint-vectors.json.
 * Reine Funktionen ohne Android-Abhängigkeit, damit sie als JVM-Unit-Test laufen.
 */
data class LinkAddress(val address: String, val prefixLength: Int)

data class LinkInfo(
  val gatewayMac: String? = null,
  val gateways: List<String>,
  val addresses: List<LinkAddress>,
  val dnsServers: List<String>,
  val domains: String?,
)

object NetworkFingerprint {
  private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

  private fun parseIpv4(ip: String): Long? {
    val m = IPV4.matchEntire(ip.trim()) ?: return null
    val parts = m.groupValues.drop(1).map { it.toLong() }
    if (parts.any { it > 255 }) return null
    return parts.fold(0L) { acc, p -> acc * 256 + p }
  }

  private fun formatIpv4(n: Long): String =
    listOf(24, 16, 8, 0).joinToString(".") { ((n shr it) and 0xff).toString() }

  /** Link-lokal (169.254/16), Loopback (127/8) und 0.0.0.0 taugen nicht als Kennung. */
  private fun usable(n: Long): Boolean {
    val first = (n shr 24) and 0xff
    val second = (n shr 16) and 0xff
    return n != 0L && first != 127L && !(first == 169L && second == 254L)
  }

  private fun normalizeMac(mac: String): String? {
    val parts = mac.trim().lowercase().replace('-', ':').split(':')
    if (parts.size != 6 || parts.any { !Regex("^[0-9a-f]{1,2}$").matches(it) }) return null
    val bytes = parts.map { it.padStart(2, '0') }
    if (bytes.all { it == "00" } || bytes.all { it == "ff" }) return null
    return bytes.joinToString(":")
  }

  private fun ipv4List(values: List<String>): List<String> =
    values.mapNotNull { parseIpv4(it) }.filter { usable(it) }.map { formatIpv4(it) }.distinct().sorted()

  fun of(link: LinkInfo): String? {
    link.gatewayMac?.let { normalizeMac(it) }?.let { return "gw=$it" }

    val gateways = ipv4List(link.gateways)
    if (gateways.isEmpty()) return null

    val nets = link.addresses.mapNotNull { (address, prefix) ->
      val n = parseIpv4(address) ?: return@mapNotNull null
      if (!usable(n) || prefix < 0 || prefix > 32) return@mapNotNull null
      val size = 1L shl (32 - prefix)
      "${formatIpv4((n / size) * size)}/$prefix"
    }.distinct().sorted()
    val dns = ipv4List(link.dnsServers)
    val domains = (link.domains ?: "")
      .lowercase()
      .split(Regex("""[\s,]+"""))
      .map { it.removeSuffix(".") }
      .filter { it.isNotEmpty() }
      .distinct()
      .sorted()

    val fields = mutableListOf("gw=${gateways.joinToString(",")}")
    if (nets.isNotEmpty()) fields += "net=${nets.joinToString(",")}"
    if (dns.isNotEmpty()) fields += "dns=${dns.joinToString(",")}"
    if (domains.isNotEmpty()) fields += "dom=${domains.joinToString(",")}"
    return "v4;" + fields.joinToString(";")
  }

  /** Gleiche Normalisierung wie Backend und Desktop: trimmen, Kleinbuchstaben, `-` → `:`. */
  fun normalize(value: String): String = value.trim().lowercase().replace('-', ':')

  fun hmacHex(key: ByteArray, value: String): String {
    if (key.isEmpty()) return ""
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(normalize(value).toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }
}

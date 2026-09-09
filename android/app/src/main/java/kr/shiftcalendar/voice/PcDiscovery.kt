package kr.shiftcalendar.voice

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

object PcDiscovery {
    fun find(): List<Connection> {
        val found = linkedMapOf<String, Connection>()
        val broadcasts = mutableSetOf(InetAddress.getByName("255.255.255.255"))
        runCatching {
            NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.forEach { network ->
                network.interfaceAddresses.mapNotNull { it.broadcast }.forEach { broadcasts.add(it) }
            }
        }
        val message = "SHIFT_CALENDAR_DISCOVER_V1".toByteArray(Charsets.UTF_8)
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 250
            val deadline = System.nanoTime() + 2_000_000_000L
            var lastSent = 0L
            while (System.nanoTime() < deadline && !Thread.currentThread().isInterrupted) {
                if (System.nanoTime() - lastSent > 600_000_000L) {
                    broadcasts.forEach { address -> runCatching { socket.send(DatagramPacket(message, message.size, address, 43827)) } }
                    lastSent = System.nanoTime()
                }
                val packet = DatagramPacket(ByteArray(2048), 2048)
                try {
                    socket.receive(packet)
                    runCatching {
                        val data = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                        if (data.optString("service") == "shiftcalendar-voice" && data.optInt("version") == 1) {
                            val connection = Connection(packet.address.hostAddress ?: "", data.getInt("port"), data.optString("name", "PC 캘린더").take(80))
                            found[connection.baseUrl] = connection
                        }
                    }
                } catch (_: SocketTimeoutException) { /* Continue until the discovery window ends. */ }
            }
        }
        return found.values.toList()
    }
}

package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class ConnectionTest {
    @Test fun acceptsPrivateNetworksWithoutKeys() {
        for (host in listOf("192.168.0.2", "10.0.2.2", "172.16.1.5", "172.31.1.5")) {
            assertEquals("http://$host:43210", Connection(host, 43210).baseUrl)
        }
    }
    @Test fun rejectsPublicAddressesAndInvalidPorts() {
        listOf("8.8.8.8", "127.0.0.1", "172.32.1.5", "192.168.001.2", "192.168.0.256", "example.com").forEach { host ->
            assertThrows(host, IllegalArgumentException::class.java) { Connection(host, 43210) }
        }
        for (port in listOf(0, -1, 65536)) assertThrows(IllegalArgumentException::class.java) { Connection("192.168.0.2", port) }
    }
}

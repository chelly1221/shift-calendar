package kr.shiftcalendar.voice

data class Connection(val host: String, val port: Int, val name: String = "PC 캘린더") {
    init {
        val parts = host.split(".")
        require(parts.size == 4 && parts.all { it.matches(Regex("[0-9]{1,3}")) && it.toInt() in 0..255 && it == it.toInt().toString() }) { "PC의 와이파이 IPv4 주소가 필요합니다." }
        val a = parts[0].toInt(); val b = parts[1].toInt()
        require(a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)) { "같은 와이파이의 PC만 연결할 수 있습니다." }
        require(port in 1..65535) { "연결 포트가 올바르지 않습니다." }
    }
    val baseUrl: String get() = "http://$host:$port"
}

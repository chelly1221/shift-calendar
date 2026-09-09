package kr.shiftcalendar.voice

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object CalendarClient {
    fun request(connection: Connection, body: JSONObject? = null, confirming: Boolean = false): JSONObject {
        val path = if (body == null) "/v1/health" else if (confirming) "/v1/confirm" else "/v1/query"
        val http = URL(connection.baseUrl + path).openConnection() as HttpURLConnection
        try {
            http.connectTimeout = 6000
            http.readTimeout = 12000
            http.instanceFollowRedirects = false
            if (body != null) {
                http.requestMethod = "POST"
                http.doOutput = true
                http.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                http.setFixedLengthStreamingMode(bytes.size)
                http.outputStream.use { it.write(bytes) }
            }
            val status = http.responseCode
            val stream = if (status in 200..299) http.inputStream else http.errorStream
            val result = stream?.use {
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = it.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= 4 * 1024 * 1024) { "PC 응답이 너무 큽니다. 질문 기간을 줄여 주세요." }
                    output.write(buffer, 0, count)
                }
                JSONObject(output.toString("UTF-8"))
            } ?: JSONObject()
            if (status !in 200..299) throw IllegalStateException(result.optString("error", "PC 연결 오류 ($status)"))
            if (body != null) {
                require(result.optString("status") in listOf("ANSWER", "CLARIFY", "UNSUPPORTED", "UNAVAILABLE", "PREVIEW") && result.opt("text") is String && result.opt("speech") is String) { "PC 응답 형식을 확인해 주세요." }
                if (result.optString("status") == "PREVIEW") require(result.optString("confirmationId").isNotBlank()) { "PC의 실행 확인 정보를 받지 못했습니다." }
            }
            return result
        } finally { http.disconnect() }
    }
}

package kr.shiftcalendar.voice

import android.os.Handler
import org.json.JSONObject
import java.util.concurrent.Executor

/** Observes PC speech; this class never creates an Android speech synthesizer. */
class PcSpeechPlayback internal constructor(
    private val connection: () -> Connection?,
    private val send: (Connection, JSONObject?, String?, (Result<JSONObject>) -> Unit) -> Unit,
    private val schedule: (Runnable, Long) -> Unit,
    private val remove: (Runnable) -> Unit,
    private val onChunk: (String) -> Unit = {},
) {
    constructor(executor: Executor, handler: Handler, connection: () -> Connection?, onChunk: (String) -> Unit = {}) : this(
        connection,
        { target, body, id, callback ->
            kotlin.runCatching {
                executor.execute {
                    val result = kotlin.runCatching { CalendarClient.speech(target, body, id) }
                    handler.post { callback(result) }
                }
            }.onFailure { callback(Result.failure(it)) }
        },
        { job, delay -> handler.postDelayed(job, delay); Unit },
        { handler.removeCallbacks(it) },
        onChunk,
    )

    var error: String? = null
        private set
    private var generation = 0
    private var closed = false
    private var activeId: String? = null
    private var activeConnection: Connection? = null
    private var done: ((Boolean) -> Unit)? = null
    private var poll: Runnable? = null
    private var lastChunk = ""
    private var failures = 0

    fun watch(playback: JSONObject, done: (Boolean) -> Unit) {
        if (closed) return
        cancel()
        error = null
        this.done = done
        activeConnection = connection()
        accept(playback, generation)
    }

    fun play(text: String, done: (Boolean) -> Unit) {
        if (closed) return
        cancel()
        error = null
        this.done = done
        if (text.isBlank()) { finish(true); return }
        val target = connection()
        if (target == null) { finish(false, "PC에 연결한 뒤 다시 읽기를 눌러 주세요."); return }
        activeConnection = target
        val token = generation
        send(target, JSONObject().put("action", "speak").put("text", text), null) { result ->
            if (token != generation || closed) {
                // Stop only the request we cancelled, even when its ID arrived after cancellation.
                result.getOrNull()?.let(::playbackObject)?.optString("id")?.takeIf { it.isNotBlank() }?.let { stopRemote(target, it) }
                return@send
            }
            result.onSuccess { accept(playbackObject(it), token) }
                .onFailure { finish(false, "PC 음성 출력을 시작하지 못했습니다. PC 연결과 프로그램을 확인해 주세요.") }
        }
    }

    private fun playbackObject(value: JSONObject): JSONObject = value.optJSONObject("playback") ?: value

    private fun accept(value: JSONObject, token: Int) {
        if (token != generation || done == null || closed) return
        val playback = playbackObject(value)
        val id = playback.optString("id")
        val status = playback.optString("status")
        if (status !in setOf("queued", "speaking", "done", "stopped", "error", "idle")) {
            finish(false, "PC 프로그램을 최신 버전으로 갱신해 주세요. 답변은 PC에서 읽습니다.")
            return
        }
        if (activeId != null && id != activeId) {
            finish(false, "PC 음성 응답 정보를 확인하지 못했습니다. 다시 읽기를 눌러 주세요.")
            return
        }
        if (id.isNotBlank()) activeId = id
        val chunk = playback.optString("chunk")
        if (chunk.isNotBlank() && chunk != lastChunk) { lastChunk = chunk; onChunk(chunk) }
        when (status) {
            "done" -> finish(true)
            "stopped" -> finish(false, "PC 음성 읽기가 중지되었습니다.")
            "error" -> finish(false, playback.optString("error").ifBlank { "PC 음성 출력을 사용할 수 없습니다. PC의 한국어 음성을 확인해 주세요." })
            "idle" -> finish(false, "PC 음성 응답을 찾지 못했습니다. 다시 읽기를 눌러 주세요.")
            else -> {
                if (activeId == null || activeConnection == null) {
                    finish(false, "PC 음성 연결 정보를 확인하지 못했습니다. PC에 다시 연결해 주세요.")
                    return
                }
                schedulePoll(token, 250)
            }
        }
    }

    private fun schedulePoll(token: Int, delay: Long) {
        poll?.let(remove)
        poll = Runnable {
            poll = null
            if (token != generation || done == null || closed) return@Runnable
            val target = activeConnection ?: return@Runnable
            val id = activeId ?: return@Runnable
            send(target, null, id) { result ->
                if (token != generation || done == null || closed) return@send
                result.onSuccess { failures = 0; accept(playbackObject(it), token) }
                    .onFailure {
                        failures++
                        if (failures < 3) schedulePoll(token, 500)
                        else {
                            stopRemote(target, id)
                            finish(false, "PC 음성 상태를 확인하지 못했습니다. 연결을 확인한 뒤 다시 읽기를 눌러 주세요.")
                        }
                    }
            }
        }.also { schedule(it, delay) }
    }

    private fun finish(success: Boolean, message: String? = null) {
        val callback = done ?: return
        error = message
        reset()
        callback(success)
    }

    private fun reset() {
        generation++
        poll?.let(remove); poll = null
        activeId = null; activeConnection = null; done = null
        lastChunk = ""; failures = 0
    }

    private fun stopRemote(target: Connection, id: String) {
        send(target, JSONObject().put("action", "stop").put("id", id), null) { }
    }

    fun cancel() {
        val target = activeConnection
        val id = activeId
        reset()
        if (target != null && id != null) stopRemote(target, id)
    }

    fun close() { cancel(); closed = true }
}

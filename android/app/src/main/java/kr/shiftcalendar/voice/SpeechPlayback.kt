package kr.shiftcalendar.voice

object SpeechChunks {
    fun split(text: String, maxLength: Int): List<String> {
        require(maxLength >= 2)
        val limit = minOf(maxLength, 240)
        val chunks = mutableListOf<String>()
        var remaining = text.trim()
        while (remaining.length > limit) {
            val boundary = (limit - 1 downTo limit / 2).firstOrNull { remaining[it] == '\n' }
                ?: (limit - 1 downTo limit / 2).firstOrNull { remaining[it].isWhitespace() }
            var cut = boundary?.plus(1) ?: limit
            if (remaining[cut - 1].isHighSurrogate() && remaining[cut].isLowSurrogate()) cut--
            chunks += remaining.substring(0, cut)
            remaining = remaining.substring(cut)
        }
        if (remaining.isNotEmpty()) chunks += remaining
        return chunks
    }
}

/** Plays one bounded utterance at a time and resumes listening only after the entire answer. */
class SpeechPlayback(
    now: () -> Long,
    schedule: (Runnable, Long) -> Unit,
    remove: (Runnable) -> Unit,
    playing: () -> Boolean,
    private val stop: () -> Unit,
    private val send: (String, String) -> Boolean,
    private val maxLength: () -> Int,
) {
    private val completion = SpeechCompletion(now, schedule, remove, playing, stop)
    private var generation = 0
    private var activeId: Int? = null
    private var chunks = emptyList<String>()
    private var index = 0
    private var done: ((Boolean) -> Unit)? = null

    fun play(text: String, finished: (Boolean) -> Unit) {
        cancel()
        chunks = SpeechChunks.split(text, maxLength())
        done = finished
        index = 0
        next(generation)
    }

    private fun next(token: Int) {
        if (token != generation || done == null) return
        if (index == chunks.size) { finish(true); return }
        val chunk = chunks[index]
        val id = completion.begin(chunk.length, {
            if (token == generation && done != null) { activeId = null; index++; next(token) }
        }, { if (token == generation) finish(false) })
        activeId = id
        if (!runCatching { send(chunk, id.toString()) }.getOrDefault(false)) finish(false)
    }

    fun completed(id: String?) { id?.toIntOrNull()?.takeIf { it == activeId }?.let(completion::finish) }
    fun started(id: String?) { id?.toIntOrNull()?.takeIf { it == activeId }?.let(completion::started) }
    fun failed(id: String?) { if (id?.toIntOrNull()?.let { it == activeId && completion.isPending(it) } == true) finish(false) }

    private fun finish(success: Boolean) {
        val callback = done ?: return
        done = null
        cancel()
        callback(success)
    }

    fun cancel() {
        generation++
        activeId = null; done = null; chunks = emptyList()
        completion.cancel()
        stop()
    }
}

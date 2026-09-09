package kr.shiftcalendar.voice

import java.text.Normalizer
import java.util.ArrayDeque

/** Main-thread FIFO. Only final, explicitly invoked questions can enter while an answer is playing. */
class SpokenQuestionQueue(private val now: () -> Long) {
    private val questions = ArrayDeque<String>()
    private var answer = ""
    private val audible = ArrayDeque<String>()
    private var echoUntil = 0L
    var speaking = false
        private set
    var awaitingFinal = false
        private set
    val size: Int get() = questions.size

    fun begin(text: String) {
        answer = compact(text)
        audible.clear()
        speaking = true
        awaitingFinal = false
        echoUntil = Long.MAX_VALUE
    }

    fun chunk(text: String) {
        audible.addLast(compact(text))
        while (audible.size > 2) audible.removeFirst()
    }

    fun partial(raw: String) {
        awaitingFinal = !matchesEcho(raw) && WakePhrase.questions(raw).any { it.isBlank() || !matchesEcho(it) }
    }

    fun accept(raw: String): Boolean {
        awaitingFinal = false
        if (matchesEcho(raw)) return false
        var added = false
        for (question in WakePhrase.questions(raw)) if (acceptQuestion(question)) added = true
        return added
    }

    private fun acceptQuestion(invocation: String): Boolean {
        var question = invocation.trim().takeIf { it.isNotEmpty() } ?: return false
        if (matchesEcho(question)) return false
        // A recognizer may append the speaker's ongoing answer after the user's question.
        val cuts = question.indices.filter { question[it].isWhitespace() }
        for (cut in cuts) {
            val tail = compact(question.substring(cut))
            if (tail.length >= 6 && answer.contains(tail) && question.substring(0, cut).isNotBlank()) {
                question = question.substring(0, cut).trimEnd()
                break
            }
        }
        if (matchesEcho(question)) return false
        val command = WakeDialogue.compact(question)
        // Confirmation is accepted only by a fresh confirmation session, never replayed from this queue.
        if (command in WakeDialogue.confirmed || command in WakeDialogue.cancelled || command in WakeDialogue.repeated) return false
        return enqueue(question)
    }

    fun enqueue(question: String): Boolean {
        val text = question.trim().take(300)
        if (text.isBlank() || questions.any { compact(it) == compact(text) }) return false
        questions.addLast(text)
        return true
    }

    fun finish() { if (speaking) { speaking = false; echoUntil = now() + 2_000 } }
    fun abandonPartial() { awaitingFinal = false }
    fun take(confirmationPending: Boolean = false): String? = if (speaking || confirmationPending) null else questions.pollFirst()

    fun isEcho(text: String): Boolean = now() <= echoUntil && matchesEcho(text)

    private fun matchesEcho(text: String): Boolean {
        if (answer.isEmpty()) return false
        val heard = compact(text)
        if (heard.isEmpty()) return false
        if (answer.contains(heard)) return true
        if (heard.length < 6 || heard.length > 320) return false
        return audible.any { nearSubstring(heard, it) }
    }

    fun clear() {
        questions.clear(); audible.clear(); answer = ""; echoUntil = 0
        speaking = false; awaitingFinal = false
    }

    private fun compact(text: String) = Normalizer.normalize(text, Normalizer.Form.NFKC)
        .lowercase().filter { it.isLetterOrDigit() }

    /** A bounded edit-distance window also rejects slightly mistranscribed playback. */
    private fun nearSubstring(heard: String, source: String): Boolean {
        var previous = IntArray(source.length + 1)
        for (i in heard.indices) {
            val current = IntArray(source.length + 1)
            current[0] = i + 1
            for (j in source.indices) current[j + 1] = minOf(current[j] + 1, previous[j + 1] + 1,
                previous[j] + if (heard[i] == source[j]) 0 else 1)
            previous = current
        }
        return previous.minOrNull()!! <= (heard.length / 6).coerceAtLeast(1)
    }
}

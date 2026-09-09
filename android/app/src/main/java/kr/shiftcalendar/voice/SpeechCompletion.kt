package kr.shiftcalendar.voice

/** Exactly one continuation, even if a TTS engine drops, repeats or delays its callbacks. Main-thread owned. */
class SpeechCompletion(
    private val now: () -> Long,
    private val schedule: (Runnable, Long) -> Unit,
    private val remove: (Runnable) -> Unit,
    private val playing: () -> Boolean,
    private val stop: () -> Unit,
) {
    private var generation = 0
    private var continuation: (() -> Unit)? = null
    private var poll: Runnable? = null
    private var resume: Runnable? = null
    private var audibleToken: Int? = null

    fun begin(characters: Int, next: () -> Unit): Int = begin(characters, next, next)

    fun begin(characters: Int, next: () -> Unit, timeout: () -> Unit): Int {
        cancel()
        val token = generation
        val started = now()
        val deadline = started + (characters * 250L + 5000).coerceIn(8000, 90_000)
        var quietSince: Long? = null
        continuation = next
        poll = object : Runnable {
            override fun run() {
                if (token != generation || continuation == null) return
                if (playing()) { audibleToken = token; quietSince = null } else if (quietSince == null) quietSince = now()
                if (now() >= deadline || (audibleToken == token && now() - started >= 1500 && quietSince?.let { now() - it >= 750 } == true)) {
                    // Complete first: a synchronous onStop must not schedule a second continuation.
                    complete(token, if (now() >= deadline) timeout else null)
                    stop()
                } else schedule(this, 250)
            }
        }.also { schedule(it, 250) }
        return token
    }

    fun finish(token: Int) {
        complete(token)
    }

    fun started(token: Int) { if (token == generation) audibleToken = token }

    fun isPending(token: Int): Boolean = token == generation && continuation != null

    private fun complete(token: Int, continuationOverride: (() -> Unit)? = null) {
        if (token != generation) return
        val pending = continuation ?: return
        val next = continuationOverride ?: pending
        continuation = null
        poll?.let(remove); poll = null
        resume = Runnable { if (token == generation) { resume = null; next() } }.also { schedule(it, 350) }
    }

    fun cancel() {
        generation++
        audibleToken = null
        continuation = null
        poll?.let(remove); poll = null
        resume?.let(remove); resume = null
    }
}

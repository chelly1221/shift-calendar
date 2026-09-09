package kr.shiftcalendar.voice

/** Normal quick restarts are quiet; missing readiness is visible and has a bounded recovery. */
class RecognitionReadiness(
    private val schedule: (Runnable, Long) -> Unit,
    private val remove: (Runnable) -> Unit,
) {
    private var generation = 0
    private var notice: Runnable? = null
    private var timeout: Runnable? = null

    fun begin(slow: () -> Unit, failed: () -> Unit) {
        cancel()
        val token = generation
        notice = Runnable { if (token == generation) { notice = null; slow() } }
            .also { schedule(it, 1500) }
        timeout = Runnable { if (token == generation) { cancel(); failed() } }
            .also { schedule(it, 10_000) }
    }

    fun cancel() {
        generation++
        notice?.let(remove); notice = null
        timeout?.let(remove); timeout = null
    }
}

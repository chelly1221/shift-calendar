package kr.shiftcalendar.voice

/** Pauses recognition, never the user's player. A short recognition beep is not sustained media. */
internal class MediaPlaybackGuard(
    private val playback: () -> Playback,
    private val schedule: (Runnable, Long) -> Unit,
    private val remove: (Runnable) -> Unit,
    private val changed: (Boolean) -> Unit,
) {
    enum class Playback { NONE, MEDIA, UNKNOWN }
    var paused = false
        private set
    private var running = false
    private var generation = 0
    private var transition: Runnable? = null
    private val fallback = object : Runnable {
        override fun run() {
            if (!running) return
            sample(playback())
            scheduleFallback()
        }
    }

    fun start() {
        if (running) return
        running = true
        if (playback() != Playback.NONE) apply(true)
        scheduleFallback()
    }

    /** Existing playback must be protected before the very first microphone session starts. */
    fun allowsListening(): Boolean {
        if (!running) return true
        if (!paused) {
            when (playback()) {
                Playback.MEDIA -> apply(true)
                // A result may be followed immediately by another capture while its ending beep
                // is still being classified. Share that short grace period across both boundaries.
                Playback.UNKNOWN -> if (transition == null) apply(true)
                Playback.NONE -> sample(Playback.NONE)
            }
        }
        return !paused
    }

    fun playbackChanged() { if (running) sample(playback()) }

    /** Do not mistake the recognizer's short ending beep for new media and discard a real question. */
    fun allowsResult(): Boolean { playbackChanged(); return !paused }

    private fun sample(value: Playback) {
        val playing = value != Playback.NONE
        if (value == Playback.MEDIA) { apply(true); return }
        if (playing == paused) { cancelTransition(); return }
        if (transition != null) return
        val token = generation
        transition = Runnable {
            if (!running || token != generation) return@Runnable
            transition = null
            if ((playback() != Playback.NONE) == playing) apply(playing)
        }.also { schedule(it, if (playing) 400 else 250) }
    }

    private fun apply(value: Boolean) {
        cancelTransition()
        if (paused == value) return
        paused = value
        if (running) scheduleFallback()
        changed(value)
    }

    private fun scheduleFallback() {
        remove(fallback)
        if (running) schedule(fallback, if (paused) 500 else 5_000)
    }

    private fun cancelTransition() {
        generation++
        transition?.let(remove)
        transition = null
    }

    fun close() {
        running = false
        cancelTransition()
        remove(fallback)
        paused = false
    }
}

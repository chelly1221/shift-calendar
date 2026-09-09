package kr.shiftcalendar.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.os.Handler

/** Read-only playback observation: no audio focus, volume, mute, or transport changes. */
internal class MediaPlaybackMonitor(context: Context, handler: Handler, changed: (Boolean) -> Unit) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val guard = MediaPlaybackGuard(::isMediaPlaying,
        { task, delay -> handler.postDelayed(task, delay); Unit }, { handler.removeCallbacks(it) }, changed)
    private val callbackHandler = handler
    private var registered = false
    private val callback = object : AudioManager.AudioPlaybackCallback() {
        override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>?) {
            guard.playbackChanged()
        }
    }
    val paused: Boolean get() = guard.paused

    private fun isMediaPlaying(): MediaPlaybackGuard.Playback {
        val configs = runCatching { audio.activePlaybackConfigurations }.getOrNull()
        if (!configs.isNullOrEmpty()) {
            val candidates = configs.map { it.audioAttributes }.filter {
                it.contentType != AudioAttributes.CONTENT_TYPE_SONIFICATION &&
                    it.usage in setOf(AudioAttributes.USAGE_MEDIA, AudioAttributes.USAGE_GAME, AudioAttributes.USAGE_UNKNOWN)
            }
            return when {
                candidates.any { it.usage != AudioAttributes.USAGE_UNKNOWN && it.contentType != AudioAttributes.CONTENT_TYPE_UNKNOWN } -> MediaPlaybackGuard.Playback.MEDIA
                candidates.isNotEmpty() -> MediaPlaybackGuard.Playback.UNKNOWN
                else -> MediaPlaybackGuard.Playback.NONE
            }
        }
        // Some devices expose no playback configurations even while their media stream is active.
        return if (runCatching { audio.isMusicActive }.getOrDefault(false)) MediaPlaybackGuard.Playback.UNKNOWN else MediaPlaybackGuard.Playback.NONE
    }

    fun start() {
        if (!registered) registered = runCatching { audio.registerAudioPlaybackCallback(callback, callbackHandler); true }.getOrDefault(false)
        guard.start()
    }
    fun allowsListening(): Boolean = guard.allowsListening()
    fun allowsResult(): Boolean = guard.allowsResult()
    fun close() {
        guard.close()
        if (registered) runCatching { audio.unregisterAudioPlaybackCallback(callback) }
        registered = false
    }
}

package kr.shiftcalendar.voice

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** The tile reflects a running microphone service, never a stale saved preference. */
class VoiceListeningTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        visibleTile = this
        render()
    }

    override fun onStopListening() {
        if (visibleTile === this) visibleTile = null
        super.onStopListening()
    }

    override fun onDestroy() {
        if (visibleTile === this) visibleTile = null
        super.onDestroy()
    }

    override fun onClick() {
        super.onClick()
        if (isListening) {
            // Only send STOP to a service that is already running; never start a microphone here.
            runCatching { startService(Intent(this, HandsFreeService::class.java).setAction(HandsFreeService.STOP)) }
                .onFailure {
                    stopService(Intent(this, HandsFreeService::class.java))
                    setListening(this, false)
                }
        } else {
            // Microphone foreground services require a visible activity on recent Android versions.
            // Launching also gives permission-denied users a normal permission request flow.
            if (isLocked) unlockAndRun(::openToEnable) else openToEnable()
        }
    }

    private fun openToEnable() {
        val open = Intent(this, MainActivity::class.java).setAction(ACTION_ENABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 4, open,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            openBeforeAndroid14(open)
        }
    }

    // Android 8–13 have no PendingIntent overload; the caller routes API 34+ above.
    @SuppressLint("StartActivityAndCollapseDeprecated")
    @Suppress("DEPRECATION")
    private fun openBeforeAndroid14(intent: Intent) {
        startActivityAndCollapse(intent)
    }

    private fun render() {
        qsTile?.apply {
            label = LABEL
            icon = Icon.createWithResource(this@VoiceListeningTileService, R.drawable.ic_listening_bird)
            state = if (isListening) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
            contentDescription = "$LABEL ${if (isListening) "켜짐" else "꺼짐"}"
            if (Build.VERSION.SDK_INT >= 29) subtitle = if (isListening) "켜짐" else "꺼짐"
            if (Build.VERSION.SDK_INT >= 30) stateDescription = if (isListening) "켜짐" else "꺼짐"
            updateTile()
        }
    }

    companion object {
        const val LABEL = "까치야 상시 듣기"
        const val ACTION_ENABLE = "kr.shiftcalendar.voice.ENABLE_HANDS_FREE"
        @Volatile var isListening = false
            private set
        private var visibleTile: VoiceListeningTileService? = null

        fun setListening(context: Context, enabled: Boolean) {
            isListening = enabled
            context.getSharedPreferences("voice", Context.MODE_PRIVATE).edit().putBoolean("wakeEnabled", enabled).apply()
            visibleTile?.render()
            runCatching { requestListeningState(context, ComponentName(context, VoiceListeningTileService::class.java)) }
        }
    }
}

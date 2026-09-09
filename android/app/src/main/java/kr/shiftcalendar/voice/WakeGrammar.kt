package kr.shiftcalendar.voice

import org.json.JSONArray

object WakeGrammar {
    fun verification(background: String): String = JSONArray(background).apply {
        // Strengthen the wake phrase and its closest non-wake alternative equally.
        // Keep all background syllables; a wake-only grammar forces arbitrary speech into a wake.
        repeat(9) { listOf("까치 야", "까 치 야", "까지 야", "까 지 야").forEach(::put) }
    }.toString()
}

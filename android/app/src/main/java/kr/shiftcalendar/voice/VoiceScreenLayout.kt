package kr.shiftcalendar.voice

/** Phones stay in one column when rotated; narrow tablet windows also use the phone layout. */
data class VoiceScreenLayout(val widthDp: Int, val smallestWidthDp: Int, val fontScale: Float = 1f) {
    val tablet = smallestWidthDp >= 600 && widthDp >= 600
    val pagePadding = if (tablet) 24 else 16
    val sidebarWidth = when {
        widthDp >= 1000 -> 304
        widthDp >= 760 -> 264
        else -> 224
    }
    val stackedActions = !tablet || widthDp < 760 || fontScale >= 1.3f
}

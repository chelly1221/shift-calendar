package kr.shiftcalendar.voice

/** Only the final transcript may be used to submit the question after the wake phrase. */
object WakePhrase {
    private val wake = Regex("(?<![가-힣a-zA-Z0-9])까\\s*치\\s*야")
    private val punctuation = setOf(',', '.', '!', '?', '。', '！', '？', ':', ';', '“', '”', '‘', '’', '"', '\'')
    private val mention = Regex("^(?:라는|라고|란(?:\\s|$)|[를가는의](?:\\s|$))")

    /** null means no invocation; an empty string means the wake phrase alone. */
    fun question(raw: String): String? {
        for (match in wake.findAll(raw)) {
            val tail = raw.substring(match.range.last + 1)
                .trimStart { it.isWhitespace() || it in punctuation }.trim()
            if (mention.containsMatchIn(tail)) continue
            return tail
        }
        return null
    }
}

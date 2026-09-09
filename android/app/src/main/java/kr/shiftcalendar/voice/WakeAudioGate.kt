package kr.shiftcalendar.voice

import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToLong

/** Compare two decodes of the same audio; a fuzzy transcript alone never activates the app. */
class WakeAudioGate(private val sampleRate: Int = 16000) {
    private val buffer = ShortArray(sampleRate * 4)
    private var samples = 0L
    private var candidateAt: Long? = null
    private var candidateEnd: Long? = null
    private var checkedThrough = -1L
    private data class Span(val start: Long, val end: Long, val text: String, val confidence: Double, val tailConfidence: Double)

    fun append(audio: ShortArray, size: Int) {
        require(size in 0..audio.size)
        for (index in 0 until size) buffer[((samples + index) % buffer.size).toInt()] = audio[index]
        samples += size
    }

    fun questionAudio(result: JSONObject, final: Boolean, verify: (ShortArray) -> JSONObject): ShortArray? {
        val candidate = spans(result, final).firstOrNull {
            it.end > checkedThrough && maxOf(0, it.start - sampleRate / 5) >= maxOf(0, samples - buffer.size)
        }
        if (candidate == null) { candidateAt = null; candidateEnd = null; return null }
        if (candidateAt == null || candidateEnd?.let { abs(it - candidate.end) > sampleRate * 150 / 1000 } == true) {
            candidateAt = samples
            candidateEnd = candidate.end
        }
        if (!final && samples - candidateAt!! < sampleRate * 150 / 1000) return null
        // Reject a failed occurrence once; an unchanged partial must not repeatedly run inference.
        checkedThrough = candidate.end + sampleRate / 4
        candidateAt = null
        candidateEnd = null

        // The first word's boundary is uncertain in connected speech. Try at most two crops,
        // only when the first is inconclusive; a recognized competing word rejects the candidate.
        for (paddingMs in listOf(200, 100)) {
            val from = maxOf(0, candidate.start - sampleRate * paddingMs / 1000)
            val until = minOf(samples, candidate.end + sampleRate * 120 / 1000)
            val leading = sampleRate / 5
            val clip = ShortArray(leading + (until - from).toInt() + sampleRate / 2)
            for (index in 0 until (until - from).toInt()) clip[leading + index] = buffer[((from + index) % buffer.size).toInt()]
            val verification = verify(clip)
            if (Regex("(?:가치|같이|사치|정치|까지)야").containsMatchIn(verification.optString("text").replace(" ", ""))) return null
            val aligned = spans(verification, final = true, allowTail = true).filter {
                abs(it.end + from - leading - candidate.end) <= sampleRate * 180 / 1000
            }
            val confirmed = aligned.firstOrNull {
                it.text == "까치야" && (
                    it.confidence >= .4 && candidate.tailConfidence >= .9 ||
                    candidate.text == "까치야" && candidate.confidence >= .7 && it.confidence >= .7)
            }
                ?: if (candidate.text == "까치야" && candidate.confidence >= .95) {
                    // Cropping can damage the first consonant. A strong exact first pass plus
                    // independently aligned 치/야 still provides evidence for the same occurrence.
                    aligned.firstOrNull { it.tailConfidence >= .4 }
                } else null
            if (confirmed == null) continue

            // Both passes refer to the same occurrence. Prefer the earlier boundary to retain consonants.
            val end = minOf(candidate.end, confirmed.end + from - leading)
            val questionFrom = (end - sampleRate / 25).coerceIn(maxOf(0, samples - buffer.size), samples)
            return ShortArray((samples - questionFrom).toInt()) { index -> buffer[((questionFrom + index) % buffer.size).toInt()] }
        }
        return null
    }

    private fun spans(result: JSONObject, final: Boolean, allowTail: Boolean = false): List<Span> {
        val words = result.optJSONArray(if (final) "result" else "partial_result") ?: return emptyList()
        val found = mutableListOf<Span>()
        for (start in 0 until words.length()) {
            var phrase = ""
            var first = -1L
            var previousEnd = -1L
            val tokens = mutableListOf<Pair<String, Double>>()
            for (index in start until minOf(start + 3, words.length())) {
                val word = words.optJSONObject(index) ?: break
                val token = word.optString("word").trim()
                val begin = word.optDouble("start") * sampleRate
                val end = word.optDouble("end") * sampleRate
                if (token.isEmpty() || !begin.isFinite() || !end.isFinite() || begin < 0 || end <= begin) break
                if (previousEnd >= 0 && (begin < previousEnd - sampleRate / 50 || begin - previousEnd > sampleRate / 5)) break
                if (index == start) first = begin.roundToLong()
                previousEnd = end.roundToLong()
                phrase += token
                val confidence = word.optDouble("conf", 0.0).takeIf { it.isFinite() && it in 0.0..1.0 } ?: 0.0
                tokens += token to confidence
                val matches = phrase == "까치치야" ||
                    phrase.length == 3 && phrase[0] in '가'..'힣' && phrase.endsWith("치야") || allowTail && phrase == "치야"
                if (matches && end - first in sampleRate * .2..sampleRate * 1.5 && (allowTail || end <= samples)) {
                    var syllables = 0
                    var tailConfidence = 1.0
                    for ((word, score) in tokens.asReversed()) {
                        if (syllables >= 2) break
                        syllables += word.length
                        tailConfidence = minOf(tailConfidence, score)
                    }
                    found += Span(first, end.roundToLong(), phrase, tokens.minOf { it.second }, tailConfidence)
                    break
                }
                if (phrase.length >= 4) break
            }
        }
        return found
    }
}

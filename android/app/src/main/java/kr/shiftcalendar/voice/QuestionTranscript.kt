package kr.shiftcalendar.voice

/** Only a completed recognition may become a command. Cancellation invalidates late callbacks. */
class QuestionTranscript(private val done: (String?) -> Unit) {
    private var finished = false

    fun result(text: String?) = finish(text)
    fun fail() = finish(null)
    fun cancel() { finished = true }
    private fun finish(text: String?) {
        if (finished) return
        finished = true
        done(text?.trim()?.takeIf(String::isNotEmpty))
    }
}

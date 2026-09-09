package kr.shiftcalendar.voice

/** Separates Android callbacks from session ownership so reuse and cancellation can be tested. */
internal interface RecognitionEngine {
    /** Connects/checks the service without opening the microphone or submitting audio. */
    fun prepare()
    fun listen(callbacks: RecognitionCallbacks)
    fun cancel()
    fun destroy()
}

internal data class RecognitionCallbacks(
    val ready: () -> Unit,
    val partial: (String) -> Unit,
    val processing: () -> Unit,
    val result: (String?) -> Unit,
    val failure: (SpeechRecognitionFailure) -> Unit,
)

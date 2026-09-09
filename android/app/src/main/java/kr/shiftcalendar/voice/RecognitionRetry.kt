package kr.shiftcalendar.voice

enum class RecognitionIssue { NO_SPEECH, TEMPORARY, THROTTLED, UNAVAILABLE }

class SpeechRecognitionFailure(val issue: RecognitionIssue, message: String) : IllegalStateException(message)

/** Silence is normal in standby. Service failures must not cause a rapid restart loop. */
class RecognitionRetry {
    private var failures = 0
    fun reset() { failures = 0 }
    fun delay(issue: RecognitionIssue): Long? = when (issue) {
        RecognitionIssue.UNAVAILABLE -> null
        RecognitionIssue.NO_SPEECH -> { reset(); 250L }
        RecognitionIssue.THROTTLED -> { failures = 6; 30_000L }
        RecognitionIssue.TEMPORARY -> (1000L shl failures.coerceAtMost(5)).coerceAtMost(30_000L)
            .also { failures = (failures + 1).coerceAtMost(6) }
    }
}

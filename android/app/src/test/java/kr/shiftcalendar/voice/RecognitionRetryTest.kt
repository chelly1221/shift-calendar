package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class RecognitionRetryTest {
    @Test fun silenceResumesQuietlyWithoutAccumulatingFailures() {
        val retry = RecognitionRetry()
        repeat(1000) { assertEquals(250L, retry.delay(RecognitionIssue.NO_SPEECH)) }
        assertEquals(1000L, retry.delay(RecognitionIssue.TEMPORARY))
    }
    @Test fun repeatedFailuresBackOffAndRemainBounded() {
        val retry = RecognitionRetry()
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L),
            List(6) { retry.delay(RecognitionIssue.TEMPORARY) })
        repeat(1000) { assertEquals(30000L, retry.delay(RecognitionIssue.TEMPORARY)) }
        retry.reset()
        assertEquals(1000L, retry.delay(RecognitionIssue.TEMPORARY))
    }
    @Test fun serviceRateLimitsWaitAndUnavailableServicesStopRetrying() {
        val retry = RecognitionRetry()
        assertEquals(30000L, retry.delay(RecognitionIssue.THROTTLED))
        assertEquals(30000L, retry.delay(RecognitionIssue.TEMPORARY))
        assertNull(retry.delay(RecognitionIssue.UNAVAILABLE))
    }
}

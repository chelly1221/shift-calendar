package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class QuestionTranscriptTest {
    @Test fun normalMicrophoneResultsAreAcceptedOnce() {
        val results = mutableListOf<String?>()
        val session = QuestionTranscript(results::add)
        session.result(" 내일 근무자 누구야 ")
        session.result("내일 근무자 누구야")
        session.fail()
        assertEquals(listOf("내일 근무자 누구야"), results)
    }

    @Test fun aTimeoutOrErrorDoesNotSubmitALateQuestion() {
        val results = mutableListOf<String?>()
        val session = QuestionTranscript(results::add)
        session.fail()
        session.result("내일 회의 삭제해줘")
        assertEquals(listOf<String?>(null), results)
    }

    @Test fun cancellationRejectsLateSpeechAndConfirmationCallbacks() {
        val results = mutableListOf<String?>()
        val session = QuestionTranscript(results::add)
        session.cancel()
        session.result("확인")
        session.fail()
        assertTrue(results.isEmpty())
    }

    @Test fun emptyRecognitionRequestsRetry() {
        val results = mutableListOf<String?>()
        QuestionTranscript(results::add).result("  ")
        QuestionTranscript(results::add).result(null)
        assertEquals(listOf<String?>(null, null), results)
    }
}

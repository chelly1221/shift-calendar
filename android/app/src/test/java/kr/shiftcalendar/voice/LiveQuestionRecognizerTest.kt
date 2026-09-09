package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class LiveQuestionRecognizerTest {
    private class Engine : RecognitionEngine {
        val sessions = mutableListOf<RecognitionCallbacks>()
        var cancels = 0
        var destroys = 0
        var cancelThrows = false
        var prepares = 0
        var prepareThrows = false
        override fun prepare() { prepares++; if (prepareThrows) error("service check failed") }
        override fun listen(callbacks: RecognitionCallbacks) { sessions += callbacks }
        override fun cancel() { cancels++; if (cancelThrows) error("broken service") }
        override fun destroy() { destroys++ }
    }

    @Test fun aThousandNormalStandbyCyclesReuseOneConnection() {
        val engines = mutableListOf<Engine>()
        val recognizer = LiveQuestionRecognizer { Engine().also(engines::add) }
        val replies = mutableListOf<Result<String>>()
        repeat(1000) {
            recognizer.listen({}, {}, replies::add)
            val callback = engines.single().sessions.last()
            callback.ready()
            if (it % 2 == 0) callback.failure(SpeechRecognitionFailure(RecognitionIssue.NO_SPEECH, "silence"))
            else callback.result("까치야 내일 근무자 누구야?")
            recognizer.cancel() // Service transitions must not tear down a completed session.
        }
        assertEquals(1000, replies.size)
        assertEquals(500, replies.count { it.isSuccess })
        assertEquals(0, engines.single().cancels)
        assertEquals(0, engines.single().destroys)
        recognizer.close()
        assertEquals(1, engines.single().destroys)
    }

    @Test fun interruptedCaptureUsesANewConnectionAndIgnoresLateConfirmation() {
        val engines = mutableListOf<Engine>()
        val recognizer = LiveQuestionRecognizer { Engine().also(engines::add) }
        val replies = mutableListOf<Result<String>>()
        var updates = 0
        recognizer.listen({ updates++ }, { updates++ }, replies::add, { updates++ })
        val old = engines.single().sessions.single()
        recognizer.cancel()
        recognizer.listen({}, {}, replies::add)
        old.ready(); old.partial("확인"); old.processing(); old.result("확인")
        old.failure(SpeechRecognitionFailure(RecognitionIssue.TEMPORARY, "late error"))
        assertEquals(0, updates)
        assertTrue(replies.isEmpty())
        assertEquals(2, engines.size)
        assertEquals(1, engines.first().destroys)
        engines.last().sessions.single().result("까치야 내일 근무자 누구야?")
        assertEquals("까치야 내일 근무자 누구야?", replies.single().getOrNull())
    }

    @Test fun duplicateOldCallbacksDoNotAffectAReusedConnection() {
        val engine = Engine()
        val recognizer = LiveQuestionRecognizer { engine }
        val replies = mutableListOf<Result<String>>()
        recognizer.listen({}, {}, replies::add)
        val old = engine.sessions.single()
        old.result("첫 질문")
        recognizer.listen({}, {}, replies::add)
        old.result("확인")
        old.failure(SpeechRecognitionFailure(RecognitionIssue.TEMPORARY, "late error"))
        engine.sessions.last().result("둘째 질문")
        assertEquals(listOf("첫 질문", "둘째 질문"), replies.map { it.getOrNull() })
        assertEquals(0, engine.destroys)
    }

    @Test fun realFailuresRebuildTheConnectionAndUnreadySilenceIsNotHealthy() {
        for (issue in RecognitionIssue.entries) {
            val engine = Engine()
            val recognizer = LiveQuestionRecognizer { engine }
            var failure: Throwable? = null
            recognizer.listen({}, {}, { failure = it.exceptionOrNull() })
            // NO_SPEECH before ready indicates a broken startup, not normal quiet standby.
            engine.sessions.single().failure(SpeechRecognitionFailure(issue, "failed"))
            assertEquals(if (issue == RecognitionIssue.NO_SPEECH) RecognitionIssue.TEMPORARY else issue,
                (failure as SpeechRecognitionFailure).issue)
            assertEquals(1, engine.destroys)
        }
    }

    @Test fun closingStillDestroysAServiceWhoseCancelThrows() {
        val engine = Engine().apply { cancelThrows = true }
        val recognizer = LiveQuestionRecognizer { engine }
        recognizer.listen({}, {}, {})
        recognizer.close()
        recognizer.close()
        assertEquals(1, engine.destroys)
    }

    @Test fun preparesBeforeAnswerEndsWithoutOpeningMicAndReusesThePreparedConnection() {
        val engines = mutableListOf<Engine>()
        val recognizer = LiveQuestionRecognizer { Engine().also(engines::add) }
        recognizer.prepare()
        repeat(10) { recognizer.prepare() }
        assertEquals(1, engines.single().prepares)
        assertTrue(engines.single().sessions.isEmpty())
        recognizer.cancel() // TTS completion transition must retain the prepared service.
        recognizer.listen({}, {}, {})
        assertEquals(1, engines.size)
        assertEquals(1, engines.single().sessions.size)
        assertEquals(0, engines.single().destroys)
    }

    @Test fun preparingAnExistingConnectionDoesNotInterruptCapture() {
        val engine = Engine()
        val recognizer = LiveQuestionRecognizer { engine }
        val replies = mutableListOf<Result<String>>()
        recognizer.listen({}, {}, replies::add)
        recognizer.prepare()
        engine.sessions.single().result("까치야 내일 일정 알려줘")
        recognizer.prepare()
        assertEquals(1, replies.size)
        assertEquals(0, engine.prepares)
        assertEquals(0, engine.destroys)
    }

    @Test fun failedPreparationIsRecoverableAndClosingPreparedResourcesIsIdempotent() {
        val engines = mutableListOf<Engine>()
        val recognizer = LiveQuestionRecognizer { Engine().also { it.prepareThrows = engines.isEmpty(); engines += it } }
        recognizer.prepare()
        assertEquals(1, engines.first().destroys)
        recognizer.prepare()
        recognizer.listen({}, {}, {})
        assertEquals(2, engines.size)
        assertEquals(1, engines.last().sessions.size)
        recognizer.close(); recognizer.close()
        assertEquals(1, engines.last().destroys)
    }
}

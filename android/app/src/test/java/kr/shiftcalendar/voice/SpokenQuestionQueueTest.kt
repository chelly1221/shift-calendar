package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class SpokenQuestionQueueTest {
    private var time = 0L
    private fun queue(answer: String = "주간 A조 김민수 이지원. 야간 B조 박지훈 최서연.") =
        SpokenQuestionQueue { time }.apply { begin(answer); chunk(answer) }

    @Test fun invokedQuestionsWaitForTheAnswerAndAreTakenInOrder() {
        val queue = queue()
        assertTrue(queue.accept("까치야, 내일 휴가 누구야?"))
        assertTrue(queue.accept("까치야 소장님 교육 언제야?"))
        assertEquals(2, queue.size)
        assertNull(queue.take())
        queue.finish()
        assertEquals("내일 휴가 누구야?", queue.take())
        queue.begin("김민수, 연차.")
        assertNull(queue.take())
        queue.finish()
        assertEquals("소장님 교육 언제야?", queue.take())
        assertNull(queue.take())
    }

    @Test fun partialTextNeverEntersTheQueueAndCanFinishAfterPlayback() {
        val queue = queue()
        queue.partial("까치야")
        assertTrue(queue.awaitingFinal)
        queue.partial("까치야 내일 주간")
        queue.finish()
        assertTrue(queue.awaitingFinal)
        assertEquals(0, queue.size)
        assertTrue(queue.accept("까치야 내일 주간 누구야?"))
        assertFalse(queue.awaitingFinal)
        assertEquals("내일 주간 누구야?", queue.take())
    }

    @Test fun severalInvocationsInOneFinalResultBecomeSeparateQuestions() {
        val queue = queue()
        assertTrue(queue.accept("까치야 내일 휴가 누구야? 까치야 소장님 교육 언제야?"))
        queue.finish()
        assertEquals("내일 휴가 누구야?", queue.take())
        assertEquals("소장님 교육 언제야?", queue.take())
    }

    @Test fun ambientSpeechWakeMentionsAndPlaybackAreNotCommands() {
        val queue = queue()
        for (text in listOf("내일 회의 삭제해줘", "주간 A조 김민수 이지원.", "까치야라는 말", "까치야", "까치야 주간 A조 김민수 이지원")) {
            assertFalse(text, queue.accept(text))
        }
        assertEquals(0, queue.size)
    }

    @Test fun aReadAloudWakeExampleCannotQueueItself() {
        val queue = queue("까치야, 내일 야간 누구야? 처럼 말하세요.")
        assertFalse(queue.accept("까치야, 내일 야간 누구야?"))
        queue.partial("까치야, 내일 야간 누구야?")
        assertFalse(queue.awaitingFinal)
        assertTrue(queue.accept("까치야 다음 달 교육 언제야?"))
    }

    @Test fun smallTranscriptionErrorsInPlaybackAreAlsoRejected() {
        val queue = queue("9월 16일 이상승 연차입니다.")
        assertFalse(queue.accept("까치야 9월 16일 이상성 연차입니다"))
        assertEquals(0, queue.size)
    }

    @Test fun echoedAnswerAfterTheQuestionIsRemoved() {
        val queue = queue("주간 A조 김민수 이지원")
        assertTrue(queue.accept("까치야 내일 교육 어디야? 주간 A조 김민수 이지원"))
        queue.finish()
        assertEquals("내일 교육 어디야?", queue.take())
    }

    @Test fun duplicateFinalsOrRepeatedQueuedQuestionsDoNotExecuteTwice() {
        val queue = queue()
        assertTrue(queue.accept("까치야 내일 휴가 누구야?"))
        assertFalse(queue.accept("까치야 내일 휴가 누구야?"))
        assertFalse(queue.accept("까치야 내일휴가누구야"))
        queue.finish()
        assertEquals("내일 휴가 누구야?", queue.take())
        assertNull(queue.take())
    }

    @Test fun confirmationAndPlaybackControlsAreNeverStoredAsFutureApprovals() {
        val queue = queue("등록 내용을 확인한 뒤 확인 또는 취소라고 말씀해 주세요.")
        for (text in listOf("확인", "까치야 확인", "까치야 네", "까치야 실행", "까치야 취소", "까치야 다시 읽어줘")) {
            assertFalse(text, queue.accept(text))
        }
        assertTrue(queue.accept("까치야 내일 회의 삭제해줘"))
        queue.finish()
        assertEquals("내일 회의 삭제해줘", queue.take())
    }

    @Test fun repeatedStandbyTransitionsDoNotExtendTheEchoWindowForever() {
        val queue = queue("까치야 내일 야간 누구야?")
        queue.finish()
        time = 1500
        queue.finish()
        assertTrue(queue.isEcho("까치야 내일 야간 누구야?"))
        time = 2100
        assertFalse(queue.isEcho("까치야 내일 야간 누구야?"))
        // A final from the old playback capture is still filtered even if it arrives late.
        assertFalse(queue.accept("까치야 내일 야간 누구야?"))
    }

    @Test fun queuedQuestionsWaitForAnOutstandingChangeConfirmation() {
        val queue = queue("내일 회의 삭제. 확인 또는 취소라고 말씀해 주세요.")
        assertTrue(queue.accept("까치야 다음 달 교육 알려줘"))
        queue.finish()
        assertNull(queue.take(confirmationPending = true))
        assertEquals(1, queue.size)
        assertEquals("다음 달 교육 알려줘", queue.take(confirmationPending = false))
    }

    @Test fun cancellingAPreviewPlaybackPreventsItsLateCompletionFromDispatchingQueuedWork() {
        val jobs = mutableMapOf<Runnable, Long>()
        val sent = mutableListOf<String>()
        val dispatched = mutableListOf<String>()
        val queue = queue("확인 또는 취소라고 말씀해 주세요.")
        val playback = SpeechPlayback({ time }, { job, delay -> jobs[job] = time + delay }, { jobs.remove(it) },
            { false }, {}, { _, id -> sent += id; true }, { 240 }, queue::chunk)
        playback.play("확인 또는 취소라고 말씀해 주세요.") {
            queue.finish(); queue.take()?.let(dispatched::add)
        }
        queue.accept("까치야 내일 휴가 누구야?")
        val oldId = sent.last()
        playback.cancel() // A manual confirmation starts a request while the preview is still speaking.
        queue.finish()
        playback.completed(oldId)
        assertTrue(dispatched.isEmpty())
        assertEquals(1, queue.size)
        assertTrue(jobs.isEmpty())
    }

    @Test fun stoppingClearsPendingQuestionsAndUnfinishedInput() {
        val queue = queue()
        queue.accept("까치야 내일 교육 어디야?")
        queue.partial("까치야 다음 주")
        queue.clear()
        assertEquals(0, queue.size)
        assertFalse(queue.awaitingFinal)
        assertNull(queue.take())
    }

    @Test fun queuedQuestionsAreNotCappedAtAFewItems() {
        val queue = queue()
        for (i in 1..50) assertTrue(queue.accept("까치야 9월 ${i}일 일정 알려줘"))
        queue.finish()
        for (i in 1..50) assertEquals("9월 ${i}일 일정 알려줘", queue.take())
        assertNull(queue.take())
    }

    @Test fun nextQuestionIsReleasedAfterTheLastSpeechChunkOnlyOnce() {
        val jobs = mutableMapOf<Runnable, Long>()
        var playing = false
        val sent = mutableListOf<Pair<String, String>>()
        val dispatched = mutableListOf<String>()
        val queue = queue("주간 A조 김민수 이지원. ".repeat(80))
        val playback = SpeechPlayback({ time }, { job, delay -> jobs[job] = time + delay }, { jobs.remove(it) },
            { playing }, { playing = false }, { text, id -> sent += text to id; playing = true; true }, { 240 }, queue::chunk)
        playback.play("주간 A조 김민수 이지원. ".repeat(80)) {
            queue.finish()
            queue.take()?.let(dispatched::add)
        }
        queue.accept("까치야 내일 휴가 누구야?")
        var count = 0
        while (dispatched.isEmpty()) {
            assertTrue(count++ < 100)
            assertNull(queue.take())
            playing = false
            val id = sent.last().second
            playback.completed(id); playback.completed(id)
            while (true) {
                val task = jobs.entries.firstOrNull { it.value <= time }?.key ?: break
                jobs.remove(task); task.run()
            }
        }
        assertTrue(sent.size > 1)
        assertEquals(listOf("내일 휴가 누구야?"), dispatched)
        playback.completed(sent.last().second)
        assertEquals(1, dispatched.size)
    }
}

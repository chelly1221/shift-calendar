package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class SpeechPlaybackTest {
    private class Clock {
        var time = 0L
        var playing = false
        var accept = true
        var stoppedCallback = false
        val jobs = mutableMapOf<Runnable, Long>()
        val sent = mutableListOf<Pair<String, String>>()
        val results = mutableListOf<Boolean>()
        val speech: SpeechPlayback = SpeechPlayback({ time }, { job, delay -> jobs[job] = time + delay }, { jobs.remove(it) }, { playing },
            { playing = false; if (stoppedCallback) onStop() },
            { text, id -> sent += text to id; playing = accept; accept }, { 4000 })
        private fun onStop() { speech.failed(sent.lastOrNull()?.second) }
        fun play(text: String) { speech.play(text) { results += it } }
        fun advance(milliseconds: Long) {
            val end = time + milliseconds
            while (true) {
                val job = jobs.entries.filter { it.value <= end }.minByOrNull { it.value } ?: break
                time = job.value; jobs.remove(job.key); job.key.run()
            }
            time = end
        }
        fun finishChunk() {
            playing = false
            val id = sent.last().second
            speech.completed(id); speech.completed(id)
            advance(350)
        }
    }

    @Test fun everyCharacterIsKeptAcrossEngineLimitsAndUnicodeBoundaries() {
        val original = (1..100).joinToString("\n") { "직원$it, 연차. 오후 2시 안전교육 🐦 " + "가".repeat(250) }
        for (limit in listOf(2, 31, 240, 4000)) {
            val chunks = SpeechChunks.split(original, limit)
            assertEquals(original, chunks.joinToString(""))
            assertTrue(chunks.all { it.length <= limit && it.isNotEmpty() })
            assertTrue(chunks.none { it.last().isHighSurrogate() || it.first().isLowSurrogate() })
        }
    }

    @Test fun longAnswersContinuePastNinetySecondsAndResumeOnlyAfterTheLastItem() {
        val clock = Clock()
        val text = (1..80).joinToString("\n") { "직원$it, 연차. 오후 2시 안전교육." }
        clock.play(text)
        var count = 0
        while (clock.results.isEmpty()) {
            assertTrue(count++ < 100)
            clock.advance(20_000)
            assertTrue(clock.results.isEmpty())
            clock.finishChunk()
        }
        assertTrue(clock.time > 90_000)
        assertEquals(text, clock.sent.joinToString("") { it.first })
        assertEquals(listOf(true), clock.results)
        assertTrue(clock.jobs.isEmpty())
    }

    @Test fun stopCancelsAllRemainingChunksAndLateCallbacks() {
        val clock = Clock()
        clock.play("긴 일정 목록 ".repeat(300))
        val id = clock.sent.last().second
        clock.speech.cancel()
        clock.speech.completed(id); clock.speech.failed(id)
        clock.advance(100_000)
        assertEquals(1, clock.sent.size)
        assertTrue(clock.results.isEmpty())
        assertTrue(clock.jobs.isEmpty())
    }

    @Test fun newAnswerReplacesTheOldPlaylistEvenDuringTheDrainDelay() {
        val clock = Clock()
        clock.play("기존 답변 ".repeat(200))
        val oldId = clock.sent.last().second
        clock.speech.completed(oldId)
        clock.play("새 답변")
        clock.speech.completed(oldId); clock.speech.failed(oldId)
        clock.finishChunk()
        clock.advance(100_000)
        assertEquals(listOf("새 답변"), clock.sent.drop(1).map { it.first })
        assertEquals(listOf(true), clock.results)
    }

    @Test fun missingCallbackContinuesAfterQuietAndIgnoresOurOwnStopNotification() {
        val clock = Clock()
        clock.stoppedCallback = true
        clock.play("목록 ".repeat(160))
        clock.speech.started(clock.sent.last().second)
        clock.playing = false
        clock.advance(2000)
        assertEquals(2, clock.sent.size)
        assertTrue(clock.results.isEmpty())
        while (clock.results.isEmpty()) clock.finishChunk()
        assertEquals(listOf(true), clock.results)
    }

    @Test fun stuckChunkFailsWithoutPretendingTheRemainingListWasRead() {
        val clock = Clock()
        clock.stoppedCallback = true
        clock.play("목록 ".repeat(200))
        clock.advance(90_000)
        assertEquals(1, clock.sent.size)
        assertEquals(listOf(false), clock.results)
        assertTrue(clock.jobs.isEmpty())
    }

    @Test fun engineRejectionAndErrorReportFailureOnce() {
        val rejected = Clock()
        rejected.accept = false
        rejected.play("답변")
        rejected.advance(90_000)
        assertEquals(listOf(false), rejected.results)
        val error = Clock()
        error.play("답변 ".repeat(200))
        val id = error.sent.last().second
        error.speech.failed(id); error.speech.failed(id); error.speech.completed(id)
        error.advance(90_000)
        assertEquals(listOf(false), error.results)
        assertEquals(1, error.sent.size)
    }

    @Test fun emptyAnswerFinishesWithoutSendingAnUtterance() {
        val clock = Clock()
        clock.play("  ")
        assertEquals(listOf(true), clock.results)
        assertTrue(clock.sent.isEmpty())
    }

    @Test fun slowSpeechStartupDoesNotSkipUnspokenItems() {
        val clock = Clock()
        clock.play("시작이 느린 음성 ".repeat(80))
        clock.playing = false // Accepted by TTS but still queued, not yet audible.
        clock.advance(4000)
        assertEquals(1, clock.sent.size)
        assertTrue(clock.results.isEmpty())
        clock.speech.started(clock.sent.last().second)
        clock.playing = true
        clock.advance(2000)
        clock.finishChunk()
        assertEquals(2, clock.sent.size)
        while (clock.results.isEmpty()) clock.finishChunk()
        assertEquals(listOf(true), clock.results)
    }
}

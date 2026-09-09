package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class SpeechCompletionTest {
    private class Clock {
        var time = 0L
        var playing = true
        var stops = 0
        val jobs = mutableMapOf<Runnable, Long>()
        val speech = SpeechCompletion({ time }, { job, delay -> jobs[job] = time + delay }, { jobs.remove(it) }, { playing }, { playing = false; stops++ })
        fun advance(milliseconds: Long) {
            val end = time + milliseconds
            while (true) {
                val job = jobs.entries.filter { it.value <= end }.minByOrNull { it.value } ?: break
                time = job.value; jobs.remove(job.key); job.key.run()
            }
            time = end
        }
    }

    @Test fun everyCompletedAnswerReturnsToWakeListeningExactlyOnce() {
        val clock = Clock()
        val dialogue = WakeDialogue()
        repeat(100) {
            dialogue.enter(WakeDialogue.Phase.WAITING)
            assertEquals(WakeDialogue.Action.Question("내일 야간 누구야"), dialogue.accept("까치야 내일 야간 누구야"))
            dialogue.enter(WakeDialogue.Phase.SPEAKING)
            var resumed = 0
            val id = clock.speech.begin(20) { resumed++; dialogue.enter(WakeDialogue.Phase.WAITING) }
            clock.speech.finish(id)
            clock.speech.finish(id) // An engine may repeat a completion/error notification.
            clock.advance(350)
            assertEquals(1, resumed)
            assertEquals(WakeDialogue.Phase.WAITING, dialogue.phase)
        }
        assertTrue(clock.jobs.isEmpty())
    }

    @Test fun missingTtsCallbackDoesNotLeaveTheMicrophonePaused() {
        val clock = Clock()
        var resumed = 0
        clock.speech.begin(20) { resumed++ }
        clock.advance(1000)
        assertEquals(0, resumed) // Never capture our own spoken answer.
        clock.playing = false
        clock.advance(1500)
        assertEquals(1, resumed)
        assertEquals(1, clock.stops)
        assertTrue(clock.jobs.isEmpty())
    }

    @Test fun stuckTtsEngineHasABoundedRecovery() {
        val clock = Clock()
        var resumed = false
        clock.speech.begin(8) { resumed = true }
        clock.advance(7999)
        assertFalse(resumed)
        clock.advance(351)
        assertTrue(resumed)
        assertEquals(1, clock.stops)
    }

    @Test fun stopAndNewAnswerDiscardDelayedCallbacksFromPreviousPlayback() {
        val clock = Clock()
        var old = 0; var current = 0
        val oldId = clock.speech.begin(20) { old++ }
        clock.speech.finish(oldId)
        val newId = clock.speech.begin(20) { current++ }
        clock.speech.finish(oldId)
        clock.advance(350)
        assertEquals(0, old); assertEquals(0, current)
        clock.speech.finish(newId)
        clock.speech.cancel() // User turns hands-free off during the speaker drain delay.
        clock.advance(10000)
        assertEquals(0, current)
        assertTrue(clock.jobs.isEmpty())
    }
}

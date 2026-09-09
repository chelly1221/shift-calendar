package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class RecognitionReadinessTest {
    private class Clock {
        var time = 0L
        val jobs = mutableMapOf<Runnable, Long>()
        val readiness = RecognitionReadiness({ task, delay -> jobs[task] = time + delay }, { jobs.remove(it) })
        fun advance(milliseconds: Long) {
            val end = time + milliseconds
            while (true) {
                val job = jobs.entries.filter { it.value <= end }.minByOrNull { it.value } ?: break
                time = job.value; jobs.remove(job.key); job.key.run()
            }
            time = end
        }
    }

    @Test fun normalRestartsDoNotDisplayReconnectionOrTriggerRecovery() {
        val clock = Clock()
        var notices = 0; var failures = 0
        repeat(1000) {
            clock.readiness.begin({ notices++ }, { failures++ })
            clock.advance(100)
            clock.readiness.cancel() // onReadyForSpeech
            clock.advance(5000)
        }
        assertEquals(0, notices); assertEquals(0, failures)
        assertTrue(clock.jobs.isEmpty())
    }

    @Test fun missingReadyIsVisibleAndRecoveredExactlyOnce() {
        val clock = Clock()
        var notices = 0; var failures = 0
        clock.readiness.begin({ notices++ }, { failures++ })
        clock.advance(1499)
        assertEquals(0, notices)
        clock.advance(1)
        assertEquals(1, notices); assertEquals(0, failures)
        clock.advance(8500)
        assertEquals(1, failures)
        clock.advance(60000)
        assertEquals(1, failures)
    }

    @Test fun cancellationAndNewCaptureDiscardAllOldTimers() {
        val clock = Clock()
        var old = 0; var current = 0
        clock.readiness.begin({ old++ }, { old++ })
        val stale = clock.jobs.keys.toList()
        clock.readiness.begin({ current++ }, { current++ })
        stale.forEach(Runnable::run)
        clock.advance(1500)
        clock.readiness.cancel()
        clock.advance(10000)
        assertEquals(0, old); assertEquals(1, current)
    }
}

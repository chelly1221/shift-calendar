package kr.shiftcalendar.voice

import kr.shiftcalendar.voice.MediaPlaybackGuard.Playback
import org.junit.Assert.*
import org.junit.Test

class MediaPlaybackGuardTest {
    private class Clock(initial: Playback = Playback.NONE) {
        var time = 0L
        var playback = initial
        val jobs = mutableMapOf<Runnable, Long>()
        val changes = mutableListOf<Boolean>()
        val guard = MediaPlaybackGuard({ playback }, { task, delay -> jobs[task] = time + delay },
            { jobs.remove(it) }, changes::add)
        fun change(value: Playback) { playback = value; guard.playbackChanged() }
        fun advance(milliseconds: Long) {
            val end = time + milliseconds
            while (true) {
                val job = jobs.entries.filter { it.value <= end }.minByOrNull { it.value } ?: break
                time = job.value; jobs.remove(job.key); job.key.run()
            }
            time = end
        }
    }

    @Test fun existingMusicPreventsEvenTheFirstRecognitionSession() {
        for (kind in listOf(Playback.MEDIA, Playback.UNKNOWN)) {
            val clock = Clock(kind)
            var captures = 0
            clock.guard.start()
            if (clock.guard.allowsListening()) captures++
            clock.advance(60_000)
            repeat(20) { if (clock.guard.allowsListening()) captures++ }
            assertEquals(0, captures)
            assertEquals(listOf(true), clock.changes)
            assertTrue(clock.guard.paused)
        }
    }

    @Test fun aFreshCheckProtectsMusicThatStartedBeforeTheCallbackArrives() {
        val clock = Clock()
        clock.guard.start()
        assertTrue(clock.guard.allowsListening())
        clock.playback = Playback.MEDIA
        assertFalse(clock.guard.allowsListening())
        assertFalse(clock.guard.allowsResult())
        assertEquals(listOf(true), clock.changes)
    }

    @Test fun knownMediaImmediatelySuspendsCaptureAndRejectsACompetingFinalResult() {
        val clock = Clock()
        clock.guard.start()
        clock.change(Playback.MEDIA)
        assertTrue(clock.guard.paused)
        assertFalse(clock.guard.allowsResult())
        assertEquals(listOf(true), clock.changes)
    }

    @Test fun aShortUnknownRecognitionBeepDoesNotCancelCaptureOrDiscardItsQuestion() {
        val clock = Clock()
        clock.guard.start()
        repeat(20) {
            clock.change(Playback.UNKNOWN)
            clock.advance(150)
            assertTrue(clock.guard.allowsResult())
            assertTrue(clock.guard.allowsListening()) // Wake-only result immediately starts question capture.
            clock.change(Playback.NONE)
            clock.advance(500)
        }
        assertTrue(clock.changes.isEmpty())
        assertFalse(clock.guard.paused)
    }

    @Test fun resultEndingBeepGraceExpiresEvenAcrossImmediateFollowUpCapture() {
        val clock = Clock()
        clock.guard.start()
        clock.playback = Playback.UNKNOWN
        assertTrue(clock.guard.allowsResult())
        assertTrue(clock.guard.allowsListening())
        clock.advance(399)
        assertTrue(clock.guard.allowsListening())
        clock.advance(1)
        assertFalse(clock.guard.allowsListening())
        assertFalse(clock.guard.allowsResult())
        assertEquals(listOf(true), clock.changes)
    }

    @Test fun sustainedUnknownPlaybackIsProtectedAfterOneShortConfirmation() {
        val clock = Clock()
        clock.guard.start()
        clock.change(Playback.UNKNOWN)
        clock.advance(399)
        assertFalse(clock.guard.paused)
        clock.advance(1)
        assertTrue(clock.guard.paused)
        assertFalse(clock.guard.allowsResult())
        assertEquals(listOf(true), clock.changes)
    }

    @Test fun playbackEndAutomaticallyResumesOnceAfter250Milliseconds() {
        val clock = Clock(Playback.MEDIA)
        clock.guard.start()
        clock.change(Playback.NONE)
        repeat(10) { clock.guard.playbackChanged() }
        clock.advance(249)
        assertFalse(clock.guard.allowsListening())
        clock.advance(1)
        assertTrue(clock.guard.allowsListening())
        assertEquals(listOf(true, false), clock.changes)
        clock.advance(10_000)
        assertEquals(listOf(true, false), clock.changes)
    }

    @Test fun aShortTrackGapDoesNotRestartRecognitionOverTheNextTrack() {
        val clock = Clock(Playback.MEDIA)
        clock.guard.start()
        clock.change(Playback.NONE)
        val oldResume = clock.jobs.keys.first { clock.jobs[it] == 250L }
        clock.advance(100)
        clock.change(Playback.MEDIA)
        oldResume.run()
        clock.advance(1_000)
        assertFalse(clock.guard.allowsListening())
        assertEquals(listOf(true), clock.changes)
    }

    @Test fun enteringMediaPauseReplacesTheSlowFallbackAndRecoversWhenEndCallbacksAreMissing() {
        val clock = Clock()
        clock.guard.start()
        assertEquals(listOf(5_000L), clock.jobs.values.toList())
        clock.advance(100)
        clock.change(Playback.MEDIA)
        assertEquals(listOf(600L), clock.jobs.values.toList())
        clock.playback = Playback.NONE // No platform callback.
        clock.advance(749)
        assertTrue(clock.guard.paused)
        clock.advance(1)
        assertFalse(clock.guard.paused)
        assertEquals(listOf(true, false), clock.changes)
        assertEquals(1, clock.jobs.size)
    }

    @Test fun slowFallbackAlsoDetectsMediaWhenEveryStartCallbackIsMissing() {
        val clock = Clock()
        clock.guard.start()
        clock.playback = Playback.MEDIA
        clock.advance(5_000)
        assertTrue(clock.guard.paused)
        assertEquals(1, clock.jobs.size)
        assertEquals(listOf(5_500L), clock.jobs.values.toList())
    }

    @Test fun closingCancelsDeferredResumeAndNeverRestartsListening() {
        val clock = Clock(Playback.MEDIA)
        clock.guard.start()
        clock.change(Playback.NONE)
        val stale = clock.jobs.keys.toList()
        clock.guard.close()
        stale.forEach(Runnable::run)
        clock.advance(60_000)
        assertTrue(clock.jobs.isEmpty())
        assertEquals(listOf(true), clock.changes)
    }
}

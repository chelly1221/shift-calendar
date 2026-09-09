package kr.shiftcalendar.voice

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WakeAudioGateTest {
    private fun transcript(vararg words: Triple<String, Double, Double>, final: Boolean = false) = JSONObject()
        .put(if (final) "text" else "partial", words.joinToString(" ") { it.first })
        .put(if (final) "result" else "partial_result", JSONArray().apply {
            words.forEach { (word, start, end) -> put(JSONObject().put("word", word).put("start", start).put("end", end).put("conf", 1.0)) }
        })
    private fun wake(start: Double = .5, end: Double = 1.0, final: Boolean = false, text: String = "까치야") =
        transcript(Triple(text, start, end), final = final)
    private fun confirmation(start: Double = .5, end: Double = 1.0, text: String = "까치야"): (ShortArray) -> JSONObject = {
        val localEnd = .2 + end - maxOf(0.0, start - .2)
        wake(localEnd - .5, localEnd, final = true, text = text)
    }

    @Test fun keepsTheQuestionAndOnlyVerifiesAShortCandidateClip() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1200) { it.toShort() }, 1200)
        assertNull(gate.questionAudio(wake(), false) { fail("Unstable candidate"); JSONObject() })
        gate.append(ShortArray(200) { (it + 1200).toShort() }, 200)
        val tail = gate.questionAudio(wake(), false) { clip ->
            assertEquals(1520, clip.size)
            assertTrue(clip.take(200).all { it == 0.toShort() })
            assertEquals(300.toShort(), clip[200])
            assertEquals(1119.toShort(), clip[1019])
            assertTrue(clip.takeLast(500).all { it == 0.toShort() })
            confirmation()(clip)
        }!!
        assertEquals(440, tail.size)
        assertEquals(960.toShort(), tail.first())
        assertEquals(1399.toShort(), tail.last())
    }

    @Test fun missedFirstSyllableRequiresIndependentAudioConfirmation() {
        for (candidate in listOf("밝치야", "낡치야", "팔치야", "까치치야")) {
            for (confirmed in listOf(false, true)) {
                val gate = WakeAudioGate(1000)
                gate.append(ShortArray(1500), 1500)
                val tail = gate.questionAudio(wake(final = true, text = candidate), true,
                    confirmation(text = if (confirmed) "까치야" else candidate))
                assertEquals("$candidate, confirmed=$confirmed", confirmed, tail != null)
            }
        }
    }

    @Test fun anExactFirstPassAlsoMustPassAudioVerification() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        assertNull(gate.questionAudio(wake(final = true), true, confirmation(text = "까지야")))
    }

    @Test fun strongExactFirstPassCanSurviveACroppedFirstConsonant() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        val verified = transcript(Triple("팔", .4, .55), Triple("치", .55, .75), Triple("야", .75, .9), final = true)
        verified.getJSONArray("result").getJSONObject(0).put("conf", .2)
        assertNotNull(gate.questionAudio(wake(final = true), true) { verified })
    }

    @Test fun twoUncertainDecodesCannotActivate() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        val uncertain = wake(final = true).apply { getJSONArray("result").getJSONObject(0).put("conf", .7) }
        assertNull(gate.questionAudio(uncertain, true, confirmation(text = "팔치야")))
    }

    @Test fun twoExactDecodesCanAgreeAfterLongStandby() {
        val gate = WakeAudioGate(1000)
        repeat(650) { gate.append(ShortArray(1000), 1000) }
        gate.append(ShortArray(1500), 1500)
        val candidate = wake(650.5, 651.0, true).apply { getJSONArray("result").getJSONObject(0).put("conf", .73) }
        assertNotNull(gate.questionAudio(candidate, true) { clip ->
            confirmation(650.5, 651.0)(clip).apply { getJSONArray("result").getJSONObject(0).put("conf", .87) }
        })
    }

    @Test fun weakVerificationDoesNotPromoteAFuzzyCandidate() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        assertNull(gate.questionAudio(wake(final = true, text = "밝치야"), true) { clip ->
            confirmation()(clip).apply { getJSONArray("result").getJSONObject(0).put("conf", .3) }
        })
    }

    @Test fun middleWakeExcludesAllPreviousWords() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(2700) { it.toShort() }, 2700)
        val value = transcript(Triple("오늘", .0, .3), Triple("뭐", .3, .6), Triple("먹지", .6, 1.0),
            Triple("밝", 1.1, 1.3), Triple("치", 1.3, 1.5), Triple("야", 1.5, 1.7), Triple("내일", 1.7, 2.0), final = true)
        val tail = gate.questionAudio(value, true, confirmation(1.1, 1.7))!!
        assertEquals(1040, tail.size)
        assertEquals(1660.toShort(), tail.first())
        assertEquals(2699.toShort(), tail.last())
    }

    @Test fun syllableSplitWakeCanFinishAcrossPartialUpdates() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1200), 1200)
        val incomplete = transcript(Triple("까", .5, .7), Triple("치", .7, .9))
        assertNull(gate.questionAudio(incomplete, false, confirmation()))
        val complete = transcript(Triple("까", .5, .7), Triple("치", .7, .9), Triple("야", .9, 1.0))
        assertNull(gate.questionAudio(complete, false, confirmation()))
        gate.append(ShortArray(200), 200)
        assertNotNull(gate.questionAudio(complete, false, confirmation()))
    }

    @Test fun aFinalCandidateDoesNotWaitForAnotherPartial() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        assertNotNull(gate.questionAudio(wake(final = true), true, confirmation()))
    }

    @Test fun changedCandidateTimeMustBecomeStableAgain() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1300), 1300)
        assertNull(gate.questionAudio(wake(), false, confirmation()))
        gate.append(ShortArray(300), 300)
        assertNull(gate.questionAudio(wake(.9, 1.4), false, confirmation(.9, 1.4)))
        gate.append(ShortArray(200), 200)
        assertNotNull(gate.questionAudio(wake(.9, 1.4), false, confirmation(.9, 1.4)))
    }

    @Test fun rejectedCandidateHasBoundedAttemptsAndLaterWakeStillWorks() {
        val gate = WakeAudioGate(1000)
        var verifications = 0
        gate.append(ShortArray(1500), 1500)
        repeat(100) {
            gate.append(ShortArray(10), 10)
            assertNull(gate.questionAudio(wake(final = true), true) { verifications++; JSONObject() })
        }
        assertEquals(2, verifications)
        gate.append(ShortArray(1500), 1500)
        val value = transcript(Triple("까치야", .5, 1.0), Triple("까치야", 3.0, 3.5), final = true)
        assertNotNull(gate.questionAudio(value, true, confirmation(3.0, 3.5)))
    }

    @Test fun uncertainCropCanUseOneAlternateBoundary() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        var attempts = 0
        val tail = gate.questionAudio(wake(final = true), true) { clip ->
            attempts++
            if (attempts == 1) JSONObject() else {
                assertEquals(1420, clip.size)
                wake(.3, .8, final = true)
            }
        }
        assertEquals(2, attempts)
        assertEquals(540, tail!!.size)
    }

    @Test fun aCompetingWordDoesNotKeepTryingOtherCrops() {
        val gate = WakeAudioGate(1000)
        gate.append(ShortArray(1500), 1500)
        var attempts = 0
        assertNull(gate.questionAudio(wake(final = true), true) { clip ->
            attempts++
            confirmation(text = "까지야")(clip)
        })
        assertEquals(1, attempts)
    }

    @Test fun oldCandidateDoesNotHideALaterOccurrenceAfterLongStandby() {
        val gate = WakeAudioGate(1000)
        repeat(100) { gate.append(ShortArray(1000) { 9 }, 1000) }
        val value = transcript(Triple("까치야", 89.5, 90.0), Triple("까치야", 98.5, 99.0), final = true)
        val tail = gate.questionAudio(value, true, confirmation(98.5, 99.0))!!
        assertEquals(1040, tail.size)
        assertTrue(tail.all { it == 9.toShort() })
    }

    @Test fun missingFutureAndInvalidTimingNeverReadsUnrelatedAudio() {
        for (value in listOf(wake(2.0, 2.5, true), wake(-.1, .5, true), wake(1.0, .5, true),
            JSONObject().put("text", "까치야"), wake(final = true).apply { getJSONArray("result").getJSONObject(0).remove("start") })) {
            val gate = WakeAudioGate(1000)
            gate.append(ShortArray(1500), 1500)
            assertNull(gate.questionAudio(value, true) { fail("Invalid timing"); JSONObject() })
        }
    }

    @Test fun aSimilarWordOrADifferentTimeInVerificationCannotActivate() {
        for (confirmed in listOf(wake(.2, .6, true), wake(.4, .9, true, "가치야"), wake(.4, .9, true, "사치야"))) {
            val gate = WakeAudioGate(1000)
            gate.append(ShortArray(1500), 1500)
            assertNull(gate.questionAudio(wake(final = true), true) { confirmed })
        }
    }

    @Test fun aWordContainingTheWakeOrSeparatedWordsAreNotCandidates() {
        for (value in listOf(wake(final = true, text = "까치야라는"), wake(final = true, text = "왕까치야"),
            wake(final = true, text = "까지야"),
            transcript(Triple("까치", .1, .4), Triple("야", 1.0, 1.2), final = true))) {
            val gate = WakeAudioGate(1000)
            gate.append(ShortArray(1500), 1500)
            assertNull(gate.questionAudio(value, true) { fail("Not a candidate"); JSONObject() })
        }
    }

    @Test fun repeatedSessionsAlwaysStartWithAFreshGate() {
        repeat(100) {
            val gate = WakeAudioGate(1000)
            gate.append(ShortArray(1500), 1500)
            assertNotNull(gate.questionAudio(wake(final = true), true, confirmation()))
        }
    }
}

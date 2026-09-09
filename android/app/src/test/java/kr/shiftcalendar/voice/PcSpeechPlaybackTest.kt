package kr.shiftcalendar.voice

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PcSpeechPlaybackTest {
    private class Fixture {
        data class Request(val target: Connection, val body: JSONObject?, val id: String?, val callback: (Result<JSONObject>) -> Unit)
        var time = 0L
        var connection: Connection? = Connection("192.168.1.4", 43828)
        val jobs = mutableMapOf<Runnable, Long>()
        val requests = mutableListOf<Request>()
        val chunks = mutableListOf<String>()
        val results = mutableListOf<Boolean>()
        val speech = PcSpeechPlayback({ connection },
            { target, body, id, callback -> requests += Request(target, body, id, callback) },
            { job, delay -> jobs[job] = time + delay }, { jobs.remove(it) }, { chunks += it })
        fun watch(value: JSONObject) { speech.watch(value) { results += it } }
        fun play(text: String = "주간 A조 김수헌") { speech.play(text) { results += it } }
        fun advance(milliseconds: Long = 250) {
            val end = time + milliseconds
            while (true) {
                val job = jobs.entries.filter { it.value <= end }.minByOrNull { it.value } ?: break
                time = job.value; jobs.remove(job.key); job.key.run()
            }
            time = end
        }
        fun respond(value: JSONObject, index: Int = requests.lastIndex) { requests[index].callback(Result.success(value)) }
        fun fail(index: Int = requests.lastIndex) { requests[index].callback(Result.failure(IllegalStateException("offline"))) }
    }

    private fun playback(status: String, id: String = "answer-1", chunk: String = ""): JSONObject = JSONObject()
        .put("id", id).put("status", status).put("text", "주간 A조 김수헌\n야간 B조 이상승").put("chunk", chunk)

    @Test fun silentPcCommandCompletesImmediatelyWithoutSpeechOrPolling() {
        val fixture = Fixture()
        fixture.watch(JSONObject().put("id", JSONObject.NULL).put("status", "done").put("text", "").put("chunk", ""))
        assertEquals(listOf(true), fixture.results)
        fixture.advance(60_000)
        assertTrue(fixture.requests.isEmpty())
        assertTrue(fixture.jobs.isEmpty())
        assertTrue(fixture.chunks.isEmpty())
        assertNull(fixture.speech.error)
    }

    @Test fun watchesExistingPcAnswerWithoutStartingAnotherUtterance() {
        val fixture = Fixture()
        fixture.watch(playback("queued"))
        assertTrue(fixture.requests.isEmpty())
        fixture.advance()
        assertEquals("answer-1", fixture.requests.single().id)
        assertNull(fixture.requests.single().body)
        fixture.respond(playback("speaking", chunk = "주간 A조 김수헌"))
        assertEquals(listOf("주간 A조 김수헌"), fixture.chunks)
        fixture.advance()
        fixture.respond(playback("done"))
        assertEquals(listOf(true), fixture.results)
        assertTrue(fixture.jobs.isEmpty())
    }

    @Test fun completionRunsImmediatelyOnlyOnceAndRetainsEveryLongAnswerChunk() {
        val fixture = Fixture()
        fixture.watch(playback("speaking", chunk = "첫 번째 답변"))
        for (index in 1..100) {
            fixture.advance(2000)
            fixture.respond(playback("speaking", chunk = "${index}번째 답변"))
            assertTrue(fixture.results.isEmpty())
        }
        assertEquals(101, fixture.chunks.size)
        assertTrue(fixture.time > 90_000)
        fixture.advance()
        fixture.respond(playback("done"))
        fixture.respond(playback("done"))
        assertEquals(listOf(true), fixture.results)
        assertTrue(fixture.jobs.isEmpty())
    }

    @Test fun repeatedStatusDoesNotPushDuplicateEchoChunks() {
        val fixture = Fixture()
        fixture.watch(playback("speaking", chunk = "주간 A조 김수헌"))
        repeat(4) { fixture.advance(); fixture.respond(playback("speaking", chunk = "주간 A조 김수헌")) }
        assertEquals(listOf("주간 A조 김수헌"), fixture.chunks)
    }

    @Test fun cancelStopsOnlyItsPcAnswerAndDiscardsLatePollResults() {
        val fixture = Fixture()
        fixture.watch(playback("speaking"))
        fixture.advance()
        fixture.speech.cancel()
        val stop = fixture.requests.last().body!!
        assertEquals("stop", stop.getString("action"))
        assertEquals("answer-1", stop.getString("id"))
        fixture.respond(playback("done"), 0)
        fixture.advance(60_000)
        assertTrue(fixture.results.isEmpty())
        assertTrue(fixture.jobs.isEmpty())
    }

    @Test fun cancellingBeforePlayResponseArrivesStopsTheLateIdWithoutStoppingNewAnswer() {
        val fixture = Fixture()
        fixture.play("오래된 답변")
        fixture.speech.cancel()
        fixture.watch(playback("speaking", "new"))
        fixture.respond(playback("speaking", "old"), 0)
        val stop = fixture.requests.last().body!!
        assertEquals("old", stop.getString("id"))
        fixture.advance()
        assertEquals("new", fixture.requests.last().id)
        fixture.respond(playback("done", "new"))
        assertEquals(listOf(true), fixture.results)
    }

    @Test fun closingBeforePlayResponseArrivesStillStopsTheLatePcSpeech() {
        val fixture = Fixture()
        fixture.play()
        fixture.speech.close()
        fixture.respond(playback("speaking"), 0)
        assertEquals("stop", fixture.requests.last().body!!.getString("action"))
        assertEquals("answer-1", fixture.requests.last().body!!.getString("id"))
        fixture.advance(60_000)
        assertTrue(fixture.results.isEmpty())
        assertTrue(fixture.jobs.isEmpty())
    }

    @Test fun newWatchStopsPreviousAnswerAndCannotBeCompletedByPreviousPoll() {
        val fixture = Fixture()
        fixture.watch(playback("speaking", "old"))
        fixture.advance()
        fixture.watch(playback("speaking", "new"))
        assertEquals("old", fixture.requests.last().body!!.getString("id"))
        fixture.respond(playback("done", "old"), 0)
        assertTrue(fixture.results.isEmpty())
        fixture.advance()
        fixture.respond(playback("done", "new"))
        assertEquals(listOf(true), fixture.results)
    }

    @Test fun replayRequestsPcSpeechAndAcceptsWrappedServerPlayback() {
        val fixture = Fixture()
        fixture.play("전체 답변")
        assertEquals("speak", fixture.requests.single().body!!.getString("action"))
        assertEquals("전체 답변", fixture.requests.single().body!!.getString("text"))
        fixture.respond(JSONObject().put("playback", playback("queued")))
        fixture.advance()
        fixture.respond(JSONObject().put("playback", playback("done")))
        assertEquals(listOf(true), fixture.results)
    }

    @Test fun disconnectedOrOldPcReportsTextErrorWithoutLocalFallback() {
        val fixture = Fixture()
        fixture.connection = null
        fixture.play()
        assertEquals(listOf(false), fixture.results)
        assertTrue(fixture.speech.error!!.contains("PC"))
        assertTrue(fixture.requests.isEmpty())
        fixture.watch(JSONObject().put("speech", "구형 PC 답변"))
        assertEquals(listOf(false, false), fixture.results)
        assertTrue(fixture.speech.error!!.contains("최신 버전"))
        assertTrue(fixture.requests.isEmpty())
    }

    @Test fun repeatedNetworkFailureStopsKnownAnswerAndReturnsFailureOnce() {
        val fixture = Fixture()
        fixture.watch(playback("speaking"))
        repeat(2) { fixture.advance(500); fixture.fail(); assertTrue(fixture.results.isEmpty()) }
        fixture.advance(500)
        fixture.fail()
        assertEquals(listOf(false), fixture.results)
        assertTrue(fixture.speech.error!!.contains("연결"))
        assertEquals("stop", fixture.requests.last().body!!.getString("action"))
        assertTrue(fixture.jobs.isEmpty())
    }

    @Test fun temporaryNetworkFailureDoesNotFinishTheAnswerOrLoseLaterChunks() {
        val fixture = Fixture()
        fixture.watch(playback("speaking"))
        fixture.advance(); fixture.fail()
        fixture.advance(500); fixture.respond(playback("speaking", chunk = "계속되는 답변"))
        assertEquals(listOf("계속되는 답변"), fixture.chunks)
        assertTrue(fixture.results.isEmpty())
        fixture.advance(); fixture.respond(playback("done"))
        assertEquals(listOf(true), fixture.results)
    }

    @Test fun pcVoiceErrorIsShownWithoutPretendingTheAnswerWasRead() {
        val fixture = Fixture()
        fixture.watch(playback("error").put("error", "PC 한국어 음성이 없습니다."))
        assertEquals(listOf(false), fixture.results)
        assertEquals("PC 한국어 음성이 없습니다.", fixture.speech.error)
        assertTrue(fixture.requests.isEmpty())
        fixture.watch(playback("stopped"))
        assertEquals(listOf(false, false), fixture.results)
    }

    @Test fun pcSelectionChangesDoNotRedirectPollOrStopToAnotherComputer() {
        val fixture = Fixture()
        val original = fixture.connection!!
        fixture.watch(playback("speaking"))
        fixture.connection = Connection("192.168.1.5", 43829)
        fixture.advance()
        assertEquals(original, fixture.requests.last().target)
        fixture.speech.close()
        assertEquals(original, fixture.requests.last().target)
        fixture.respond(playback("done"), 0)
        fixture.advance(60_000)
        assertTrue(fixture.results.isEmpty())
    }

    @Test fun queuedWakeQuestionWaitsForPcCompletionAndRejectsPcEcho() {
        val fixture = Fixture()
        val queue = SpokenQuestionQueue { fixture.time }
        val dispatched = mutableListOf<String>()
        queue.begin("주간 A조 김수헌\n야간 B조 이상승")
        queue.chunk("주간 A조 김수헌")
        fixture.speech.watch(playback("speaking")) {
            assertTrue(it)
            queue.finish()
            queue.take()?.let(dispatched::add)
        }
        assertFalse(queue.accept("주간 A조 김수헌"))
        assertTrue(queue.accept("까치야 내일 일정 알려줘"))
        assertNull(queue.take())
        fixture.advance()
        fixture.respond(playback("done"))
        assertEquals(listOf("내일 일정 알려줘"), dispatched)
    }
}

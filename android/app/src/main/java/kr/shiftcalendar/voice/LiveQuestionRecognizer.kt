package kr.shiftcalendar.voice

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.SpeechRecognizer
import java.util.concurrent.Executor

/** The normal Android microphone path, also available before Android 13. Main-thread only. */
class LiveQuestionRecognizer internal constructor(private val createEngine: () -> RecognitionEngine) {
    constructor(context: Context) : this({ AndroidRecognitionEngine(context) })

    private var generation = 0
    private var recognizer: RecognitionEngine? = null
    private var transcript: QuestionTranscript? = null

    /** Prepare recognition resources without starting microphone capture. */
    fun prepare() {
        if (transcript != null || recognizer != null) return
        try {
            val speech = createEngine().also { recognizer = it }
            speech.prepare()
        } catch (_: RuntimeException) {
            close() // Normal listen will report an actionable error or create a fresh connection.
        }
    }

    fun listen(ready: () -> Unit, partial: (String) -> Unit, done: (Result<String>) -> Unit, processing: () -> Unit = {}) {
        cancel()
        val token = generation
        var failure = SpeechRecognitionFailure(RecognitionIssue.NO_SPEECH, "잘 듣지 못했습니다. 다시 말씀해 주세요.")
        var wasReady = false
        val session = QuestionTranscript { text ->
            if (token == generation) {
                // onResults/onError already finished capture. Keep the service bound between turns.
                transcript = null
                generation++
                if (text == null && failure.issue == RecognitionIssue.NO_SPEECH && !wasReady) {
                    failure = SpeechRecognitionFailure(RecognitionIssue.TEMPORARY, "마이크 준비가 완료되지 않아 다시 연결합니다.")
                }
                if (text == null && failure.issue != RecognitionIssue.NO_SPEECH) close()
                done(text?.let { Result.success(it) } ?: Result.failure(failure))
            }
        }
        transcript = session
        try {
            val speech = recognizer ?: createEngine().also { recognizer = it }
            speech.listen(RecognitionCallbacks(
                ready = { if (token == generation) { wasReady = true; ready() } },
                partial = { if (token == generation) partial(it) },
                processing = { if (token == generation) processing() },
                result = session::result,
                failure = { if (token == generation) { failure = it; session.fail() } },
            ))
        } catch (error: RuntimeException) {
            failure = error as? SpeechRecognitionFailure ?: SpeechRecognitionFailure(
                if (error is SecurityException) RecognitionIssue.UNAVAILABLE else RecognitionIssue.TEMPORARY,
                "음성인식을 시작하지 못했습니다. 마이크와 음성 서비스를 확인해 주세요.")
            session.fail()
        }
    }

    fun cancel() {
        generation++
        val capturing = transcript != null
        transcript?.cancel(); transcript = null
        // Interrupted capture cannot safely share callbacks with a new confirmation session.
        if (capturing) close()
    }

    fun close() {
        generation++
        transcript?.cancel(); transcript = null
        val speech = recognizer
        recognizer = null
        speech?.let { runCatching { it.cancel() }; runCatching { it.destroy() } }
    }
}

private class AndroidRecognitionEngine(context: Context) : RecognitionEngine {
    private val speech = if (SpeechRecognizer.isRecognitionAvailable(context)) SpeechRecognizer.createSpeechRecognizer(context)
        else throw SpeechRecognitionFailure(RecognitionIssue.UNAVAILABLE, "기본 음성인식 서비스를 확인해 주세요.")

    override fun prepare() {
        if (Build.VERSION.SDK_INT >= 33) {
            speech.checkRecognitionSupport(recognitionIntent(), Executor { it.run() }, object : RecognitionSupportCallback {
                override fun onSupportResult(support: RecognitionSupport) = Unit
                override fun onError(error: Int) = Unit // Unsupported checks must not disable normal recognition.
            })
        }
    }

    private fun recognitionIntent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
        .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        .apply {
            if (Build.VERSION.SDK_INT >= 33) putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS,
                arrayListOf("까치야", "일근", "주간", "야간", "반복업무", "중요", "출장", "교육", "일정", "휴가"))
        }

    override fun listen(callbacks: RecognitionCallbacks) {
        speech.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = callbacks.ready()
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(value: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() = callbacks.processing()
                override fun onEvent(type: Int, params: Bundle?) {}
                override fun onPartialResults(results: Bundle?) {
                    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let(callbacks.partial)
                }
                override fun onResults(results: Bundle?) = callbacks.result(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull())
                override fun onError(code: Int) {
                    val issue = when (code) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> RecognitionIssue.NO_SPEECH
                        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> RecognitionIssue.THROTTLED
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS,
                        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> RecognitionIssue.UNAVAILABLE
                        else -> RecognitionIssue.TEMPORARY
                    }
                    val errorMessage = when (code) {
                        SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "음성 서비스가 잠시 대기 중입니다. 30초 뒤 다시 연결합니다."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "음성 서비스 연결을 확인해 주세요."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "마이크 권한을 확인해 주세요."
                        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "한국어 음성인식을 준비해 주세요."
                        else -> "잘 듣지 못했습니다. 다시 말씀해 주세요."
                    }
                    callbacks.failure(SpeechRecognitionFailure(issue, errorMessage))
                }
            })
            speech.startListening(recognitionIntent())
    }
    override fun cancel() = speech.cancel()
    override fun destroy() = speech.destroy()
}

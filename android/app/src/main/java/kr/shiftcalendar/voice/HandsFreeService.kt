package kr.shiftcalendar.voice

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.os.*
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executors

/** Owns audio, network and TTS independently of the activity or the screen state. */
class HandsFreeService : Service() {
    data class State(val status: String, val enabled: Boolean = true, val busy: Boolean = false, val question: String = "", val answer: String = "", val pending: Boolean = false, val connection: Connection? = null, val choices: List<Connection> = emptyList())
    inner class LocalBinder : Binder() {
        fun observe(callback: ((State) -> Unit)?) { observer = callback; callback?.invoke(state) }
        fun ask(text: String) = submit(text)
        fun listen() = beginQuestion(hasPending())
        fun confirm(value: Boolean) = confirmPending(value)
        fun replay() = replayAnswer()
        fun stopSpeech() { spokenQuestions.clear(); awaitWake() }
        fun discover() = discoverPc()
        fun choose(value: Connection) { connection = value; publish(state.status, choices = emptyList()) }
        fun stop() = stopAssistant()
    }
    private val handler = Handler(Looper.getMainLooper())
    private val network = Executors.newSingleThreadExecutor()
    private val dialogue = WakeDialogue()
    private val spokenQuestions = SpokenQuestionQueue(SystemClock::elapsedRealtime)
    private var afterSpeechCapture: (() -> Unit)? = null
    private var speechCaptureFinishTimeout: Runnable? = null
    private val prefs by lazy { getSharedPreferences("voice", MODE_PRIVATE) }
    private lateinit var liveQuestionRecognizer: LiveQuestionRecognizer
    private var observer: ((State) -> Unit)? = null
    private var state = State("까치야 음성 대기 준비 중…", busy = true)
    private var notificationStatus = ""
    private var readyOnce = false
    private val recognitionReadiness = RecognitionReadiness(
        { task, delay -> handler.postDelayed(task, delay); Unit }, { handler.removeCallbacks(it) })
    private var connection: Connection? = null
    private var context: JSONObject? = null
    private var pendingId: String? = null
    private var pendingConnection: Connection? = null
    private var pendingUntil = 0L
    private var lastSpeech = ""
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val speechPlayback by lazy { SpeechPlayback(SystemClock::elapsedRealtime,
        { task, delay -> handler.postDelayed(task, delay); Unit }, { handler.removeCallbacks(it) },
        { runCatching { tts?.isSpeaking == true }.getOrDefault(false) }, { tts?.stop() },
        { text, id -> ttsReady && tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.SUCCESS },
        TextToSpeech::getMaxSpeechInputLength, spokenQuestions::chunk) }
    private var captureId = 0
    private var requestId = 0
    private var networkBusy = false
    private var discoveryBusy = false
    private var stopped = false
    private var started = false
    private val recognitionRetry = RecognitionRetry()
    private var retryWake: Runnable? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val captureTimeout = Runnable {
        when (dialogue.phase) {
            WakeDialogue.Phase.WAITING -> recoverRecognition(captureId,
                SpeechRecognitionFailure(RecognitionIssue.TEMPORARY, "음성인식을 다시 연결하는 중…"))
            WakeDialogue.Phase.QUESTION, WakeDialogue.Phase.CONFIRMATION -> awaitWake()
            WakeDialogue.Phase.SPEAKING -> recoverSpeechCapture(captureId,
                SpeechRecognitionFailure(RecognitionIssue.TEMPORARY, "답변 중 질문 듣기를 다시 준비합니다."))
            else -> Unit
        }
    }
    private val renewLock = object : Runnable {
        override fun run() { if (!stopped) { wakeLock?.acquire(10 * 60_000L); handler.postDelayed(this, 9 * 60_000L) } }
    }

    override fun onCreate() {
        super.onCreate()
        val channel = NotificationChannel(CHANNEL, "까치야 음성 대기", NotificationManager.IMPORTANCE_LOW).apply { setSound(null, null); lockscreenVisibility = Notification.VISIBILITY_PRIVATE }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        liveQuestionRecognizer = LiveQuestionRecognizer(applicationContext)
    }
    override fun onBind(intent: Intent): IBinder = LocalBinder()
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { stopAssistant(); return START_NOT_STICKY }
        if (intent == null) { stopSelf(); return START_NOT_STICKY }
        if (started) return START_NOT_STICKY
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { fail("마이크 권한을 허용한 뒤 앱에서 음성 대기를 켜 주세요."); return START_NOT_STICKY }
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NOTIFICATION, notification())
        } catch (_: RuntimeException) { fail("앱을 화면에 연 뒤 음성 대기를 다시 켜 주세요."); return START_NOT_STICKY }
        started = true
        prefs.edit().putBoolean("wakeEnabled", true).apply()
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shiftcalendar:voice").apply { setReferenceCounted(false) }
        renewLock.run()
        tts = TextToSpeech(this) { code ->
            if (stopped) return@TextToSpeech
            ttsReady = code == TextToSpeech.SUCCESS && (tts?.setLanguage(Locale.KOREAN) ?: -1) >= TextToSpeech.LANG_AVAILABLE
            tts?.voices?.firstOrNull { it.locale.language == "ko" && !it.isNetworkConnectionRequired }?.let { tts?.voice = it }
        }
        tts?.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) { handler.post { speechPlayback.started(id) } }
            override fun onDone(id: String?) { handler.post { speechPlayback.completed(id) } }
            override fun onStop(id: String?, interrupted: Boolean) { handler.post { speechPlayback.failed(id) } }
            override fun onError(id: String?, code: Int) { handler.post { speechPlayback.failed(id) } }
            @Deprecated("Android callback") override fun onError(id: String?) { handler.post { speechPlayback.failed(id) } }
        })
        awaitWake()
        discoverPc()
        // A stopped or killed microphone service is restarted only while the activity is visible.
        return START_NOT_STICKY
    }
    private fun notification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, HandsFreeService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_launcher).setContentTitle("까치야 · 음성 대기")
            .setContentText(state.status)
            .setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE).setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "대기 끄기", stop).build()).build()
    }
    private fun publish(status: String, busy: Boolean = networkBusy, question: String = state.question, answer: String = state.answer, choices: List<Connection> = state.choices) {
        val next = State(status, !stopped, busy, question, answer, hasPending(), connection, choices)
        if (next == state) return
        state = next
        observer?.invoke(state)
        if (started && !stopped && status != notificationStatus) {
            notificationStatus = status
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
        }
    }
    private fun hasPending(): Boolean {
        if (pendingId != null && SystemClock.elapsedRealtime() >= pendingUntil) clearPending()
        return pendingId != null
    }
    private fun clearPending() { pendingId = null; pendingConnection = null; pendingUntil = 0 }
    private fun stopCapture() {
        captureId++
        handler.removeCallbacks(captureTimeout)
        recognitionReadiness.cancel()
        retryWake?.let(handler::removeCallbacks); retryWake = null
        liveQuestionRecognizer.cancel()
    }
    private fun cancelSpeech() {
        afterSpeechCapture = null
        speechCaptureFinishTimeout?.let(handler::removeCallbacks); speechCaptureFinishTimeout = null
        spokenQuestions.finish(); spokenQuestions.abandonPartial()
        speechPlayback.cancel()
    }
    private fun awaitWake() {
        if (stopped) return
        cancelSpeech()
        stopCapture()
        val continuing = dialogue.phase == WakeDialogue.Phase.WAITING
        dialogue.enter(WakeDialogue.Phase.WAITING)
        if (!readyOnce) publish("음성 대기 준비 중…")
        else if (!continuing) publish("다음 질문을 기다립니다.")
        val token = captureId
        watchReadiness(token)
        handler.postDelayed(captureTimeout, 45_000)
        liveQuestionRecognizer.listen(
            ready = { recognitionReadiness.cancel(); readyOnce = true; publish(WAITING_STATUS) },
            partial = { text ->
                // Partial results can revise the wake phrase or the question. Never submit them.
                WakePhrase.question(text)?.let { publish("질문을 듣고 있습니다.", question = it) }
            },
            done = { result ->
                if (!stopped && token == captureId) {
                    handler.removeCallbacks(captureTimeout)
                    recognitionReadiness.cancel()
                    result.onSuccess { recognitionRetry.reset(); handleSpeech(it) }
                        .onFailure { recoverRecognition(token, it) }
                }
            })
    }
    private fun watchReadiness(token: Int) {
        recognitionReadiness.begin(
            slow = { if (!stopped && token == captureId) publish("음성 서비스 응답을 기다리는 중…") },
            failed = { recoverRecognition(token, SpeechRecognitionFailure(
                RecognitionIssue.TEMPORARY, "마이크 준비가 지연되어 다시 연결합니다.")) })
    }
    private fun queueWake(delay: Long, normal: Boolean = true) {
        stopCapture()
        dialogue.enter(WakeDialogue.Phase.WAITING)
        if (normal && readyOnce) publish(WAITING_STATUS)
        val token = captureId
        retryWake = Runnable {
            retryWake = null
            if (!stopped && token == captureId) awaitWake()
        }.also { handler.postDelayed(it, delay) }
    }
    private fun recoverRecognition(token: Int, failure: Throwable) {
        if (stopped || token != captureId) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { fail("마이크 권한을 허용해 주세요."); return }
        val issue = (failure as? SpeechRecognitionFailure)?.issue ?: RecognitionIssue.TEMPORARY
        val delay = recognitionRetry.delay(issue)
        if (delay == null) { fail(failure.message ?: "기본 음성인식 서비스를 확인해 주세요."); return }
        if (issue != RecognitionIssue.NO_SPEECH) liveQuestionRecognizer.close()
        if (issue != RecognitionIssue.NO_SPEECH) publish(failure.message ?: "음성인식을 다시 연결하는 중…")
        queueWake(delay, normal = issue == RecognitionIssue.NO_SPEECH)
    }
    private fun beginQuestion(confirming: Boolean = false) {
        if (stopped) return
        if (networkBusy) { awaitWake(); return }
        cancelSpeech()
        stopCapture()
        dialogue.enter(if (confirming) WakeDialogue.Phase.CONFIRMATION else WakeDialogue.Phase.QUESTION)
        publish("마이크를 준비하는 중…", question = "")
        val token = captureId
        watchReadiness(token)
        handler.postDelayed(captureTimeout, 18_000)
        liveQuestionRecognizer.listen(
            ready = { recognitionReadiness.cancel(); publish(if (confirming) "‘확인’ 또는 ‘취소’를 듣고 있습니다." else "질문을 듣고 있습니다.") },
            partial = { publish(state.status, question = it) },
            processing = { publish("질문을 인식하는 중…") },
            done = { result ->
                if (!stopped && token == captureId) {
                    handler.removeCallbacks(captureTimeout)
                    recognitionReadiness.cancel()
                    result.onSuccess(::handleSpeech).onFailure { failure -> recoverRecognition(token, failure) }
                }
            })
    }
    private fun handleSpeech(text: String) {
        if (networkBusy) { awaitWake(); return }
        if (dialogue.phase == WakeDialogue.Phase.WAITING &&
            (spokenQuestions.isEcho(text) || WakePhrase.question(text)?.let(spokenQuestions::isEcho) == true)) { queueWake(250); return }
        when (val action = dialogue.accept(text, confirmingWake = hasPending())) {
            WakeDialogue.Action.Ignore -> queueWake(250)
            is WakeDialogue.Action.Question -> submit(action.text)
            is WakeDialogue.Action.Confirm -> confirmPending(action.value)
            WakeDialogue.Action.Cancel -> if (hasPending()) confirmPending(false) else speak("취소했습니다.") { awaitWake() }
            WakeDialogue.Action.Repeat -> replayAnswer()
            WakeDialogue.Action.ClarifyConfirmation -> speak("확인 또는 취소라고 말씀해 주세요.") { beginQuestion(true) }
            WakeDialogue.Action.Wake -> beginQuestion(hasPending())
        }
    }
    private fun speak(text: String, next: () -> Unit) {
        if (stopped) return
        stopCapture()
        cancelSpeech()
        spokenQuestions.begin(text)
        dialogue.enter(WakeDialogue.Phase.SPEAKING)
        publishSpeechQueue()
        speechPlayback.play(text) { success ->
            if (!stopped) {
                spokenQuestions.finish()
                val finish = {
                    stopCapture()
                    if (!success) publish("음성 읽기가 중단되었습니다. 다시 읽기를 눌러 주세요.")
                    val queued = spokenQuestions.take(confirmationPending = hasPending())
                    if (queued != null) { dialogue.enter(WakeDialogue.Phase.BUSY); submit(queued) }
                    else next()
                }
                if (spokenQuestions.awaitingFinal) {
                    // Preserve a question that began just before TTS ended. Partial text is never submitted.
                    afterSpeechCapture = finish
                    publish("다음 질문을 인식하는 중…")
                    speechCaptureFinishTimeout = Runnable {
                        if (!stopped && afterSpeechCapture != null) {
                            spokenQuestions.abandonPartial()
                            publish("다음 질문을 끝까지 듣지 못했습니다. 다시 말씀해 주세요.")
                            finishSpeechCapture()
                        }
                    }.also { handler.postDelayed(it, 10_000) }
                } else finish()
            }
        }
        if (!stopped && spokenQuestions.speaking) listenDuringSpeech()
    }
    private fun publishSpeechQueue() {
        publish(if (spokenQuestions.size == 0) "답변 중 · ‘까치야’로 다음 질문을 말씀하세요."
            else "답변 중 · 다음 질문 ${spokenQuestions.size}개 대기")
    }
    private fun listenDuringSpeech() {
        if (stopped || !spokenQuestions.speaking) return
        stopCapture()
        spokenQuestions.abandonPartial()
        val token = captureId
        recognitionReadiness.begin(
            slow = { if (!stopped && token == captureId) publish("답변 중 · 다음 질문 마이크를 준비하고 있습니다.") },
            failed = { recoverSpeechCapture(token, SpeechRecognitionFailure(RecognitionIssue.TEMPORARY, "답변 중 질문 듣기를 다시 준비합니다.")) })
        handler.postDelayed(captureTimeout, 45_000)
        liveQuestionRecognizer.listen(
            ready = { recognitionReadiness.cancel(); readyOnce = true; if (spokenQuestions.speaking) publishSpeechQueue() },
            partial = { spokenQuestions.partial(it) },
            done = { result ->
                if (!stopped && token == captureId) {
                    handler.removeCallbacks(captureTimeout)
                    recognitionReadiness.cancel()
                    result.onSuccess {
                        recognitionRetry.reset()
                        spokenQuestions.accept(it)
                        if (afterSpeechCapture != null) finishSpeechCapture()
                        else if (spokenQuestions.speaking) { publishSpeechQueue(); retrySpeechCapture(250) }
                    }.onFailure { recoverSpeechCapture(token, it) }
                }
            }
        )
    }
    private fun finishSpeechCapture() {
        val next = afterSpeechCapture ?: return
        afterSpeechCapture = null
        speechCaptureFinishTimeout?.let(handler::removeCallbacks); speechCaptureFinishTimeout = null
        next()
    }
    private fun retrySpeechCapture(delay: Long) {
        stopCapture()
        val token = captureId
        retryWake = Runnable {
            retryWake = null
            if (!stopped && token == captureId && spokenQuestions.speaking) listenDuringSpeech()
        }.also { handler.postDelayed(it, delay) }
    }
    private fun recoverSpeechCapture(token: Int, failure: Throwable) {
        if (stopped || token != captureId) return
        spokenQuestions.abandonPartial()
        if (afterSpeechCapture != null) { finishSpeechCapture(); return }
        val issue = (failure as? SpeechRecognitionFailure)?.issue ?: RecognitionIssue.TEMPORARY
        val delay = recognitionRetry.delay(issue)
        if (issue != RecognitionIssue.NO_SPEECH) liveQuestionRecognizer.close()
        if (delay == null) { stopCapture(); publish("답변 중 질문 듣기를 사용할 수 없습니다. 마이크와 음성 서비스를 확인해 주세요."); return }
        if (issue != RecognitionIssue.NO_SPEECH) publish("답변 중 · 다음 질문 듣기를 다시 준비합니다.")
        retrySpeechCapture(delay)
    }
    private fun resumeAfterAnswer() {
        if (hasPending()) beginQuestion(true)
        else if (context?.optJSONObject("clarification") != null) beginQuestion()
        else awaitWake()
    }
    private fun replayAnswer() { speak(lastSpeech.ifBlank { "아직 읽어드릴 답변이 없습니다." }, ::resumeAfterAnswer) }

    private fun submit(raw: String) {
        if (stopped || networkBusy || raw.isBlank()) return
        if (dialogue.phase == WakeDialogue.Phase.SPEAKING) {
            spokenQuestions.enqueue(raw)
            publishSpeechQueue()
            return
        }
        val text = raw.trim().take(300)
        val compact = WakeDialogue.compact(text)
        if (compact in WakeDialogue.repeated) { replayAnswer(); return }
        if (hasPending() && compact in WakeDialogue.confirmed) { confirmPending(true); return }
        if (compact in WakeDialogue.cancelled) { if (hasPending()) confirmPending(false) else speak("취소했습니다.") { awaitWake() }; return }
        clearPending(); cancelSpeech(); stopCapture(); dialogue.enter(WakeDialogue.Phase.BUSY)
        networkBusy = true
        publish("PC 일정을 확인하는 중…", question = text)
        val token = ++requestId
        val existing = connection
        val body = JSONObject().put("text", text).put("timeZone", "Asia/Seoul").put("selfName", prefs.getString("selfName", ""))
        context?.let { body.put("context", it) }
        network.execute {
            var target = existing
            val result = runCatching {
                if (target == null) {
                    val choices = findPcs()
                    check(choices.size == 1) { if (choices.isEmpty()) "같은 와이파이의 PC를 찾지 못했습니다." else "PC가 여러 대입니다. 앱에서 연결할 PC를 선택해 주세요." }
                    target = choices.single()
                }
                CalendarClient.request(target!!, body)
            }
            handler.post {
                if (stopped || token != requestId) return@post
                networkBusy = false
                result.onSuccess { connection = target; receiveAnswer(it) }.onFailure {
                    connection = null; context = null
                    lastSpeech = "PC 응답을 받지 못했습니다. 연결을 확인해 주세요."
                    publish(lastSpeech, answer = lastSpeech)
                    speak(lastSpeech) { awaitWake() }
                    // Never replay an uncertain command, especially relative month navigation.
                }
            }
        }
    }
    private fun receiveAnswer(value: JSONObject) {
        context = value.optJSONObject("context")
        lastSpeech = ConciseSpeech.format(value.getString("speech"), value.optString("status"))
        clearPending()
        if (value.optString("status") == "PREVIEW") {
            pendingId = value.getString("confirmationId"); pendingConnection = connection
            pendingUntil = SystemClock.elapsedRealtime() + 110_000
        }
        publish("답변을 받았습니다.", answer = ConciseSpeech.forDisplay(value.getString("text"), value.optString("status")))
        speak(lastSpeech, ::resumeAfterAnswer)
    }
    private fun confirmPending(confirm: Boolean) {
        if (stopped || networkBusy) return
        if (!hasPending()) { speak("확인할 작업이 없거나 확인 시간이 지났습니다.") { awaitWake() }; return }
        val id = pendingId!!
        val target = pendingConnection!!
        cancelSpeech(); stopCapture(); dialogue.enter(WakeDialogue.Phase.BUSY); networkBusy = true
        publish(if (confirm) "PC에 적용하는 중…" else "취소하는 중…")
        val token = ++requestId
        network.execute {
            val result = runCatching { CalendarClient.request(target, JSONObject().put("confirmationId", id).put("confirm", confirm), true) }
            handler.post {
                if (stopped || token != requestId) return@post
                networkBusy = false
                result.onSuccess(::receiveAnswer).onFailure {
                    lastSpeech = "처리 결과를 확인하지 못했습니다. 다시 확인이라고 말해 주세요."
                    publish(lastSpeech, answer = lastSpeech)
                    speak(lastSpeech) { awaitWake() }
                }
            }
        }
    }
    private fun findPcs() = PcDiscovery.find().take(8).filter { candidate -> runCatching { CalendarClient.request(candidate).let { it.optString("service") == "shiftcalendar-voice" && it.optInt("version") == 1 } }.getOrDefault(false) }
    private fun discoverPc() {
        if (stopped || networkBusy || discoveryBusy) return
        discoveryBusy = true; connection = null; context = null; clearPending()
        publish(state.status, choices = emptyList())
        val token = requestId
        network.execute {
            val choices = runCatching { findPcs() }.getOrDefault(emptyList())
            handler.post {
                discoveryBusy = false
                // A question or a manual PC selection takes precedence over background discovery.
                if (stopped || token != requestId || connection != null) return@post
                connection = choices.singleOrNull()
                publish(state.status, choices = if (choices.size > 1) choices else emptyList())
            }
        }
    }
    private fun fail(message: String) { publish(message, answer = message); stopAssistant(message) }
    private fun stopAssistant(message: String = "까치야 음성 대기를 껐습니다.") {
        if (stopped) return
        stopped = true; prefs.edit().putBoolean("wakeEnabled", false).apply()
        spokenQuestions.clear()
        stopCapture(); liveQuestionRecognizer.close(); cancelSpeech()
        state = state.copy(status = message, enabled = false, busy = false, pending = false)
        observer?.invoke(state)
        stopSelf()
    }
    override fun onDestroy() {
        stopped = true; requestId++; dialogue.enter(WakeDialogue.Phase.STOPPED)
        spokenQuestions.clear()
        handler.removeCallbacksAndMessages(null)
        stopCapture(); liveQuestionRecognizer.close(); cancelSpeech(); tts?.shutdown()
        wakeLock?.let { if (it.isHeld) it.release() }
        network.shutdownNow(); observer = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        private const val WAITING_STATUS = "음성 대기 중 · ‘까치야’와 질문을 이어서 말씀하세요."
        private const val CHANNEL = "kkachi-listening"
        private const val NOTIFICATION = 7001
        const val STOP = "kr.shiftcalendar.voice.STOP_LISTENING"
    }
}

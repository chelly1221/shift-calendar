package kr.shiftcalendar.voice

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.StatusBarManager
import android.content.Intent
import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.net.Uri
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.Gravity
import android.view.WindowInsets
import android.view.inputmethod.EditorInfo
import android.widget.*
import org.json.JSONObject
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val green = Color.rgb(17, 107, 94)
    private val ink = Color.rgb(29, 49, 45)
    private val muted = Color.rgb(91, 108, 99)
    private val executor = Executors.newSingleThreadExecutor()
    private val prefs by lazy { getSharedPreferences("voice", MODE_PRIVATE) }
    private lateinit var input: EditText
    private lateinit var answer: TextView
    private lateinit var source: TextView
    private lateinit var status: TextView
    private lateinit var connectionLabel: TextView
    private lateinit var microphone: Button
    private lateinit var submit: Button
    private lateinit var actionRow: LinearLayout
    private lateinit var confirmButton: Button
    private lateinit var cancelButton: Button
    private var pendingConfirmation: String? = null
    private var confirmationConnection: Connection? = null
    private val recognizer by lazy { LiveQuestionRecognizer(this) }
    private val handler = Handler(Looper.getMainLooper())
    private val speechPlayback by lazy { PcSpeechPlayback(executor, handler, { connection }) }
    private var listening = false
    private var active = false
    private var working = false
    private var requestGeneration = 0
    private var connection: Connection? = null
    private var context: JSONObject? = null
    private var lastSpeech = ""
    private lateinit var wakeButton: Button
    private var handsFree: HandsFreeService.LocalBinder? = null
    private var handsFreeBound = false
    private var handsFreeEnabled = true
    private var requestingWakePermissions = false
    private var lastPcChoices = emptyList<Connection>()
    private var lastHandsFreeQuestion = ""
    private val handsFreeConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            handsFree = binder as? HandsFreeService.LocalBinder
            handsFree?.observe(::renderHandsFree)
        }
        override fun onServiceDisconnected(name: ComponentName?) {
            handsFree = null
            setWorking(false)
            status.text = "음성 대기가 중단되었습니다. 앱을 다시 열거나 대기를 다시 켜 주세요."
        }
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun rounded(color: Int, radius: Int = 20): GradientDrawable = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius).toFloat() }
    private fun text(value: String, size: Float = 15f, color: Int = ink) = TextView(this).apply { text = value; textSize = size; setTextColor(color); setLineSpacing(dp(4).toFloat(), 1f) }
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun button(label: String, prominent: Boolean = false, action: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 16f
        setTextColor(if (prominent) Color.WHITE else green)
        background = rounded(if (prominent) green else Color.rgb(226, 237, 227), 16)
        minHeight = dp(52); setPadding(dp(12), dp(8), dp(12), dp(8))
        setOnClickListener { action() }
    }
    private fun LinearLayout.add(view: View, margin: Int = 12) {
        addView(view, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(margin) })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs.edit().remove("localOnly").apply()
        val layout = VoiceScreenLayout(availableWidthDp(), resources.configuration.smallestScreenWidthDp, resources.configuration.fontScale)
        val wide = layout.tablet
        val root = column().apply { setBackgroundColor(Color.rgb(243, 245, 239)); isFocusableInTouchMode = true }
        root.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        val content = column().apply { setPadding(dp(layout.pagePadding), dp(12), dp(layout.pagePadding), dp(16)) }
        root.addView(content, LinearLayout.LayoutParams(-1, -1))
        setContentView(root)
        val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        val heading = column()
        heading.add(text("까치야", if (wide) 28f else 24f).apply { setTypeface(null, Typeface.BOLD) }, 0)
        if (wide) heading.add(text("근무 · 일정 도우미", 13f, muted), 0)
        header.addView(heading, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(button("설정") { showSettings() }, LinearLayout.LayoutParams(-2, -2))
        content.add(header, 0)

        val body = LinearLayout(this).apply { orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL }
        if (wide) {
            content.addView(body, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(16) })
        } else {
            // Split-screen and enlarged display settings still expose every control.
            content.addView(ScrollView(this).apply { isFillViewport = true; addView(body) }, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = dp(12) })
        }
        val sidebar = column()
        if (wide) {
            body.addView(ScrollView(this).apply { isFillViewport = true; addView(sidebar) }, LinearLayout.LayoutParams(dp(layout.sidebarWidth), -1).apply { marginEnd = dp(16) })
        } else body.add(sidebar, 0)

        handsFreeEnabled = prefs.getBoolean("wakeEnabled", true)
        val voiceCard = column().apply { background = rounded(Color.rgb(226, 237, 227)); setPadding(dp(16), dp(14), dp(16), dp(14)) }
        sidebar.add(voiceCard, 0)
        voiceCard.add(text("음성 대기", 13f, green).apply { setTypeface(null, Typeface.BOLD) }, 0)
        status = text("음성 대기를 준비하는 중…", if (wide) 21f else 18f).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        voiceCard.add(status, 12)
        voiceCard.add(text("“까치야, 내일 야간 누구야?”", 16f, green), 16)
        voiceCard.add(text("답변은 PC에서 읽습니다. 답변 중에도 ‘까치야’로 질문하세요.", 13f, muted), 4)
        wakeButton = button(if (handsFreeEnabled) "음성 대기 끄기" else "음성 대기 켜기") {
            if (handsFreeEnabled) disableHandsFree() else enableHandsFree()
        }
        voiceCard.add(wakeButton, 16)

        val connectionCard = column().apply { background = rounded(Color.WHITE); setPadding(dp(18), dp(16), dp(18), dp(16)) }
        sidebar.add(connectionCard, 12)
        connectionCard.add(text("연결된 PC", 13f, muted).apply { setTypeface(null, Typeface.BOLD) }, 0)
        connectionLabel = text("PC를 찾고 있습니다…", 15f)
        connectionCard.add(connectionLabel, 8)
        connectionCard.add(button("PC 다시 찾기") { if (!working) discoverPc() }, 12)

        val conversation = column()
        if (wide) body.addView(conversation, LinearLayout.LayoutParams(0, -1, 1f))
        else body.add(conversation, 16)
        val answerCard = column().apply { background = rounded(Color.WHITE); setPadding(dp(16), dp(16), dp(16), dp(16)) }
        if (wide) conversation.addView(answerCard, LinearLayout.LayoutParams(-1, 0, 1f))
        else conversation.add(answerCard, 0)
        answerCard.add(text("답변", 15f, green).apply { setTypeface(null, Typeface.BOLD) }, 0)
        val answerActions = LinearLayout(this).apply { orientation = if (layout.stackedActions && resources.configuration.fontScale >= 1.3f) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL }
        val replay = button("다시 읽기") { speak() }
        val stopReading = button("읽기 중지") { if (handsFreeEnabled) handsFree?.stopSpeech() else stopSpeech() }
        addActions(answerActions, replay, stopReading)
        answerCard.add(answerActions, 8)
        val answerContent = column()
        answer = text(savedInstanceState?.getString("answer") ?: "무엇이 궁금하세요?\n근무와 일정을 물어보세요.", if (wide) 24f else 22f).apply {
            setTextIsSelectable(true); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        answerContent.add(answer, 12)
        source = text(savedInstanceState?.getString("source") ?: "", 12f, muted)
        answerContent.add(source, 12)
        if (wide) answerCard.addView(ScrollView(this).apply { addView(answerContent) }, LinearLayout.LayoutParams(-1, 0, 1f))
        else answerCard.add(answerContent, 0)
        actionRow = LinearLayout(this).apply { visibility = View.GONE; orientation = if (layout.stackedActions) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL }
        confirmButton = button("확인 · 실행", true) { confirmAction(true) }
        cancelButton = button("취소") { confirmAction(false) }
        addActions(actionRow, confirmButton, cancelButton)
        answerCard.add(actionRow, 12)

        val queryCard = column().apply { background = rounded(Color.rgb(232, 240, 231)); setPadding(dp(18), dp(12), dp(18), dp(14)) }
        conversation.add(queryCard, 12)
        input = EditText(this).apply {
            hint = "질문을 말하거나 입력하세요"; textSize = 17f; setTextColor(ink)
            minLines = 1; maxLines = 3; filters = arrayOf(InputFilter.LengthFilter(300))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            imeOptions = EditorInfo.IME_ACTION_SEND
            setOnEditorActionListener { _, actionId, _ -> if (actionId == EditorInfo.IME_ACTION_SEND) { ask(); true } else false }
        }
        queryCard.add(input, 0)
        val queryActions = LinearLayout(this).apply { orientation = if (layout.stackedActions) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL }
        microphone = button("눌러서 질문", true) { if (listening) stopListening() else startListening() }
        submit = button("질문 보내기") { stopListening(); ask() }
        addActions(queryActions, microphone, submit)
        queryCard.add(queryActions, 8)
        val examples = LinearLayout(this)
        for (example in listOf("오늘 주간 누구야?", "내일 야간 누구야?", "다음 달 보여줘")) {
            examples.addView(button(example) { if (!working) { input.setText(example); stopListening(); ask() } }.apply { textSize = 13f }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(8) })
        }
        val exampleStrip = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(examples) }
        conversation.add(exampleStrip, 10)
        if (wide) root.addOnLayoutChangeListener { view, _, top, _, bottom, _, _, _, _ ->
            // Keep the question and send controls reachable when the keyboard reduces the height.
            val short = bottom - top - view.paddingTop - view.paddingBottom < dp(420)
            answerCard.visibility = if (short) View.GONE else View.VISIBLE
            exampleStrip.visibility = if (short) View.GONE else View.VISIBLE
        }
        lastSpeech = savedInstanceState?.getString("speech") ?: ""
        input.setText(savedInstanceState?.getString("question") ?: "")
        root.requestFocus()
        refreshConnectionLabel()
    }

    private fun availableWidthDp(): Int {
        if (Build.VERSION.SDK_INT < 30) return resources.configuration.screenWidthDp
        val metrics = windowManager.currentWindowMetrics
        val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        return ((metrics.bounds.width() - insets.left - insets.right) / resources.displayMetrics.density).toInt()
    }

    private fun addActions(row: LinearLayout, first: View, second: View) {
        if (row.orientation == LinearLayout.VERTICAL) {
            row.add(first, 0); row.add(second, 8)
        } else {
            row.addView(first, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(4) })
            row.addView(second, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = dp(4) })
        }
    }

    private fun refreshConnectionLabel() {
        connectionLabel.text = connection?.let { "연결됨  "+it.name+" · "+it.host } ?: "PC를 자동으로 찾고 있습니다…"
    }

    private fun renderHandsFree(value: HandsFreeService.State) {
        if (!active) return
        handsFreeEnabled = value.enabled
        if (!value.enabled) unbindHandsFree()
        wakeButton.text = if (value.enabled) "음성 대기 끄기" else "음성 대기 켜기"
        connection = value.connection
        connectionLabel.text = value.connection?.let { "연결됨  ${it.name} · ${it.host}" } ?: "연결된 PC 없음"
        setWorking(value.busy)
        status.text = value.status
        if (value.question.isNotBlank() && value.question != lastHandsFreeQuestion) {
            lastHandsFreeQuestion = value.question
            input.setText(value.question)
        }
        if (value.answer.isNotBlank()) { answer.text = value.answer; source.text = "PC 캘린더 기준" }
        actionRow.visibility = if (value.pending) View.VISIBLE else View.GONE
        if (value.choices.isNotEmpty() && value.choices != lastPcChoices) {
            lastPcChoices = value.choices
            AlertDialog.Builder(this).setTitle("연결할 PC 선택")
                .setItems(value.choices.map { "${it.name} (${it.host})" }.toTypedArray()) { _, index -> handsFree?.choose(value.choices[index]) }
                .setNegativeButton("취소", null).show()
        }
    }
    private fun enableHandsFree() {
        if (!active || requestingWakePermissions) return
        handsFreeEnabled = true
        prefs.edit().putBoolean("wakeEnabled", true).apply()
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestingWakePermissions = true
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 20)
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("notificationAsked", false)) {
            requestingWakePermissions = true
            prefs.edit().putBoolean("notificationAsked", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 21)
            return
        }
        startHandsFreeService()
    }
    private fun startHandsFreeService() {
        if (!active) return
        requestGeneration++; stopListening(); stopSpeech()
        clearConfirmation()
        wakeButton.text = "음성 대기 끄기"
        setWorking(true); status.text = "까치야 음성 대기를 준비하는 중…"
        try {
            startForegroundService(Intent(this, HandsFreeService::class.java))
            if (!handsFreeBound) handsFreeBound = bindService(Intent(this, HandsFreeService::class.java), handsFreeConnection, BIND_AUTO_CREATE)
            else handsFree?.observe(::renderHandsFree)
        } catch (_: RuntimeException) {
            handsFreeEnabled = false; prefs.edit().putBoolean("wakeEnabled", false).apply()
            VoiceListeningTileService.setListening(this, false)
            wakeButton.text = "음성 대기 켜기"; setWorking(false)
            status.text = "앱을 화면에 연 상태에서 마이크 권한을 확인하고 대기를 다시 켜 주세요."
        }
    }
    private fun unbindHandsFree() {
        handsFree?.observe(null)
        if (handsFreeBound) unbindService(handsFreeConnection)
        handsFreeBound = false; handsFree = null
    }
    private fun disableHandsFree() {
        handsFree?.stop()
        stopService(Intent(this, HandsFreeService::class.java))
        unbindHandsFree()
        handsFreeEnabled = false; prefs.edit().putBoolean("wakeEnabled", false).apply()
        VoiceListeningTileService.setListening(this, false)
        wakeButton.text = "음성 대기 켜기"
        setWorking(false); clearConfirmation(); discoverPc()
    }

    private fun showSettings() {
        val options = column().apply { setPadding(dp(24), dp(8), dp(24), dp(20)) }
        options.add(button("내 이름 설정") { showSelfName() }, 0)
        options.add(button("빠른 설정에 상시 듣기 추가") { addListeningTile() }, 12)
        options.add(text("상단을 내려 새 모양의 ‘까치야 상시 듣기’로 켜고 끌 수 있습니다. 켤 때는 마이크 준비를 위해 앱이 열립니다.", 13f, muted), 4)
        options.add(text("음성 대기를 켜면 호출어와 질문을 기본 음성인식으로 듣습니다. 음성 서비스가 인터넷을 사용할 수 있으며 PC에는 호출어 뒤 질문 텍스트만 보냅니다.", 13f, muted), 4)
        options.add(button("배터리 설정 열기") {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }, 20)
        options.add(text("오래 대기하려면 배터리를 ‘제한 없음’으로 설정하세요. 재부팅 후에는 앱을 다시 열어 주세요.", 13f, muted), 8)
        AlertDialog.Builder(this).setTitle("설정")
            .setView(ScrollView(this).apply { addView(options) })
            .setPositiveButton("닫기", null).show()
    }

    private fun addListeningTile() {
        if (Build.VERSION.SDK_INT < 33) {
            AlertDialog.Builder(this).setTitle("상시 듣기 타일 추가")
                .setMessage("화면 상단을 두 번 내리고 빠른 설정의 편집 버튼을 누른 뒤, 새 모양의 ‘까치야 상시 듣기’를 끌어서 추가하세요.")
                .setPositiveButton("확인", null).show()
            return
        }
        runCatching {
            getSystemService(StatusBarManager::class.java).requestAddTileService(
                ComponentName(this, VoiceListeningTileService::class.java), VoiceListeningTileService.LABEL,
                Icon.createWithResource(this, R.drawable.ic_listening_bird), mainExecutor) { result ->
                val message = when (result) {
                    StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED -> "빠른 설정에 상시 듣기를 추가했습니다."
                    StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> "이미 빠른 설정에 추가되어 있습니다."
                    StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED -> "빠른 설정의 편집 화면에서도 추가할 수 있습니다."
                    else -> "빠른 설정을 편집해 ‘까치야 상시 듣기’를 추가해 주세요."
                }
                Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            }
        }.onFailure { Toast.makeText(this, "빠른 설정을 편집해 ‘까치야 상시 듣기’를 추가해 주세요.", Toast.LENGTH_LONG).show() }
    }

    private fun showSelfName() {
        val name = EditText(this).apply { hint = "캘린더에 등록된 이름"; setText(prefs.getString("selfName", "")); filters = arrayOf(InputFilter.LengthFilter(40)) }
        AlertDialog.Builder(this).setTitle("내 이름 설정 (선택)").setMessage("‘나 내일 근무야?’처럼 질문할 때 사용합니다.").setView(name)
            .setNegativeButton("취소", null).setPositiveButton("저장") { _, _ ->
                prefs.edit().putString("selfName", name.text.toString().trim()).apply(); context = null
            }.show()
    }

    private fun discoverPc(retryQuestion: String? = null) {
        if (handsFreeEnabled) { handsFree?.discover(); return }
        stopListening(); stopSpeech(); connection = null; context = null
        clearConfirmation()
        setWorking(true); connectionLabel.text = "같은 와이파이의 PC를 찾는 중…"
        status.text = "PC 캘린더가 실행되어 있는지 확인해 주세요."
        val generation = ++requestGeneration
        executor.execute {
            val result = runCatching {
                PcDiscovery.find().take(8).filter { candidate ->
                    runCatching { CalendarClient.request(candidate).let { it.optInt("version") == 1 && it.optString("service") == "shiftcalendar-voice" } }.getOrDefault(false)
                }
            }
            runOnUiThread {
                if (!active || generation != requestGeneration) return@runOnUiThread
                setWorking(false)
                val choices = result.getOrDefault(emptyList())
                when (choices.size) {
                    0 -> {
                        connectionLabel.text = "PC를 찾지 못했습니다"
                        status.text = "같은 와이파이·PC 앱 실행·Windows 방화벽의 사설 네트워크 허용을 확인한 뒤 PC 다시 찾기를 눌러 주세요."
                    }
                    1 -> useConnection(choices[0], retryQuestion)
                    else -> {
                        connectionLabel.text = "PC가 여러 대 발견되었습니다"
                        AlertDialog.Builder(this).setTitle("연결할 PC 선택")
                            .setItems(choices.map { it.name+" ("+it.host+")" }.toTypedArray()) { _, index -> useConnection(choices[index], retryQuestion) }
                            .setNegativeButton("취소", null).show()
                    }
                }
            }
        }
    }

    private fun useConnection(found: Connection, retryQuestion: String?) {
        connection = found; context = null; refreshConnectionLabel()
        status.text = "자동 연결했습니다. 질문해 보세요."
        if (retryQuestion != null) { input.setText(retryQuestion); ask(false) }
    }

    private fun connectionError(error: Throwable): String = when (error) {
        is java.net.SocketTimeoutException -> "PC 응답이 늦습니다. PC 앱과 같은 와이파이·방화벽 설정을 확인해 주세요."
        is java.io.IOException -> "PC에 연결할 수 없습니다. 같은 와이파이인지, PC 앱의 휴대폰 연결이 켜져 있는지 확인해 주세요."
        is IllegalArgumentException, is IllegalStateException -> error.message ?: "연결 정보를 확인해 주세요."
        else -> "PC 응답을 읽지 못했습니다. PC 앱을 업데이트하고 다시 연결해 주세요."
    }

    private fun setWorking(value: Boolean) {
        working = value; input.isEnabled = !value; submit.isEnabled = !value; microphone.isEnabled = !value
        confirmButton.isEnabled = !value; cancelButton.isEnabled = !value
    }

    private fun clearConfirmation() {
        pendingConfirmation = null; confirmationConnection = null; actionRow.visibility = View.GONE
    }

    private fun displayAnswer(value: JSONObject) {
        answer.text = ConciseSpeech.forDisplay(value.getString("text"), value.optString("status"))
        val playback = value.optJSONObject("playback")
        lastSpeech = playback?.optString("text") ?: value.optString("speech")
        context = value.optJSONObject("context")
        source.text = "${value.optString("source")} · 방금 처리"
        clearConfirmation()
        if (value.optString("status") == "PREVIEW") {
            pendingConfirmation = value.optString("confirmationId").takeIf { it.isNotBlank() }
            confirmationConnection = connection
            actionRow.visibility = if (pendingConfirmation == null) View.GONE else View.VISIBLE
            status.text = "내용을 확인한 뒤 ‘확인’ 또는 ‘취소’라고 말해 주세요."
        } else status.text = if (value.optString("status") == "CLARIFY") "질문을 조금 더 구체적으로 말씀해 주세요." else "처리했습니다."
        if (playback != null) {
            recognizer.prepare()
            speechPlayback.watch(playback) { success ->
                if (!success && active) status.text = speechPlayback.error ?: "PC에서 음성을 읽지 못했습니다. 화면에서 답변을 확인해 주세요."
            }
        } else status.text = "PC 프로그램을 업데이트하면 PC에서 답변을 읽습니다."
    }

    private fun discardAnswer(target: Connection, value: JSONObject?) {
        val id = value?.optJSONObject("playback")?.optString("id")?.takeIf { it.isNotBlank() } ?: return
        runCatching {
            executor.execute { runCatching { CalendarClient.speech(target, JSONObject().put("action", "stop").put("id", id)) } }
        }
    }

    private fun confirmAction(confirmed: Boolean) {
        if (handsFreeEnabled) { handsFree?.confirm(confirmed); return }
        if (working) return
        val id = pendingConfirmation ?: return
        val target = confirmationConnection ?: return
        stopListening(); stopSpeech(); setWorking(true)
        status.text = if (confirmed) "PC에 적용하는 중…" else "취소하는 중…"
        val generation = ++requestGeneration
        executor.execute {
            val result = runCatching { CalendarClient.request(target, JSONObject().put("confirmationId", id).put("confirm", confirmed), true) }
            runOnUiThread {
                if (!active || generation != requestGeneration) { discardAnswer(target, result.getOrNull()); return@runOnUiThread }
                setWorking(false)
                result.onSuccess { displayAnswer(it) }.onFailure {
                    status.text = "결과를 확인하지 못했습니다. 실행 버튼을 다시 누르면 같은 작업의 결과를 확인합니다."
                    answer.text = connectionError(it)
                    lastSpeech = ""; source.text = "PC 적용 여부 확인 필요"
                }
            }
        }
    }

    private fun ask(allowRediscovery: Boolean = true) {
        if (working) return
        val question = input.text.toString().trim()
        if (question.isEmpty()) { status.text = "질문을 입력하거나 말해 주세요."; return }
        if (handsFreeEnabled) { handsFree?.ask(question); return }
        if (question.replace(Regex("[\\s.!?]"), "") in listOf("확인", "실행", "확인해줘", "등록해", "진행해")) {
            if (pendingConfirmation != null) confirmAction(true) else status.text = "확인 대기 중인 작업이 없습니다."
            return
        }
        if (question.replace(" ", "") in listOf("다시읽어줘", "다시말해줘")) { speak(); return }
        if (question.replace(" ", "") in listOf("그만", "중지", "취소")) {
            stopSpeech(); context = null
            if (pendingConfirmation != null) confirmAction(false) else status.text = "중지했습니다."
            return
        }
        clearConfirmation()
        val target = connection
        if (target == null) { discoverPc(question); return }
        stopSpeech(); setWorking(true); status.text = "PC의 일정을 확인하는 중…"
        val generation = ++requestGeneration
        val body = JSONObject().put("text", question).put("timeZone", "Asia/Seoul").put("selfName", prefs.getString("selfName", "") ?: "")
        context?.let { body.put("context", it) }
        executor.execute {
            val result = runCatching { CalendarClient.request(target, body).also {
                require(it.optString("status") in listOf("ANSWER", "CLARIFY", "UNSUPPORTED", "UNAVAILABLE", "PREVIEW") && it.has("text") && it.has("speech")) { "PC 응답 형식을 확인해 주세요." }
            } }
            runOnUiThread {
                if (!active || generation != requestGeneration) { discardAnswer(target, result.getOrNull()); return@runOnUiThread }
                setWorking(false)
                result.onSuccess { value ->
                    displayAnswer(value)
                }.onFailure {
                    context = null; lastSpeech = ""
                    answer.text = connectionError(it)
                    source.text = "연결 실패 · 최신 일정을 확인하지 못했습니다."
                    status.text = "PC 연결을 확인해 주세요."
                    connection = null
                    // Reconnect, but never replay a navigation command after an uncertain response.
                    if (allowRediscovery && it is java.io.IOException) discoverPc()
                }
            }
        }
    }

    private fun speak() {
        if (handsFreeEnabled) { handsFree?.replay(); return }
        if (lastSpeech.isEmpty()) return
        stopListening()
        recognizer.prepare()
        if (connection == null) { status.text = "답변을 읽으려면 PC에 연결해 주세요."; return }
        speechPlayback.play(lastSpeech) { success ->
            if (!success && active) status.text = speechPlayback.error ?: "PC에서 음성을 읽지 못했습니다. 화면에서 답변을 확인해 주세요."
        }
    }

    private fun startListening() {
        if (working) return
        if (handsFreeEnabled) { handsFree?.listen(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 10); return
        }
        stopSpeech()
        listening = true; microphone.text = "듣기 취소"; status.text = "듣고 있어요…"
        recognizer.listen(
            ready = { if (listening && active) status.text = "말씀해 주세요." },
            partial = { if (listening && active) input.setText(it) },
            processing = { if (listening && active) status.text = "질문을 인식하는 중…" },
            done = { result ->
                if (listening && active) {
                    stopListening()
                    result.onSuccess { input.setText(it); ask() }
                        .onFailure { status.text = it.message ?: "잘 듣지 못했습니다. 다시 말씀해 주세요." }
                }
            })
    }

    private fun stopSpeech() { speechPlayback.cancel() }
    private fun stopListening() { listening = false; recognizer.cancel(); microphone.text = "눌러서 질문" }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 20 || requestCode == 21) {
            requestingWakePermissions = false
            if (requestCode == 20 && grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
                handsFreeEnabled = false; prefs.edit().putBoolean("wakeEnabled", false).apply()
                VoiceListeningTileService.setListening(this, false)
                wakeButton.text = "음성 대기 켜기"
                setWorking(false); status.text = "상시 대기에 마이크 권한이 필요합니다. 직접 입력도 사용할 수 있습니다."
                discoverPc()
            } else if (active) enableHandsFree()
            return
        }
        if (requestCode == 10 && active) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startListening()
            else status.text = "마이크 권한이 필요합니다. 직접 입력도 사용할 수 있습니다."
        }
    }
    private fun consumeTileEnable(): Boolean {
        if (intent?.action != VoiceListeningTileService.ACTION_ENABLE) return false
        intent.action = null
        prefs.edit().putBoolean("wakeEnabled", true).apply()
        return true
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (active && consumeTileEnable()) enableHandsFree()
    }
    override fun onStart() { super.onStart(); active = true; consumeTileEnable(); handsFreeEnabled = prefs.getBoolean("wakeEnabled", true); if (handsFreeEnabled) enableHandsFree() else discoverPc() }
    override fun onStop() { active = false; requestGeneration++; stopListening(); stopSpeech(); unbindHandsFree(); setWorking(false); super.onStop() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("answer", answer.text.toString()); outState.putString("source", source.text.toString())
        outState.putString("question", input.text.toString()); outState.putString("speech", lastSpeech)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        speechPlayback.close(); recognizer.close()
        // Let delayed replies be cancelled by ID before closing their network executor.
        executor.execute { handler.post { executor.shutdown() } }
        super.onDestroy()
    }
}

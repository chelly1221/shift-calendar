package kr.shiftcalendar.voice

/** Audio-independent state rules: ambient speech never becomes a calendar request. */
class WakeDialogue {
    enum class Phase { WAITING, QUESTION, CONFIRMATION, BUSY, SPEAKING, STOPPED }
    sealed class Action {
        data object Ignore : Action()
        data object Wake : Action()
        data class Question(val text: String) : Action()
        data class Confirm(val value: Boolean) : Action()
        data object Repeat : Action()
        data object Cancel : Action()
        data object ClarifyConfirmation : Action()
    }
    var phase = Phase.STOPPED
        private set
    fun enter(value: Phase) { phase = value }

    fun accept(raw: String, confirmingWake: Boolean = false): Action {
        var text = raw.trim()
        if (phase == Phase.WAITING) {
            text = WakePhrase.question(text) ?: return Action.Ignore
            phase = if (confirmingWake) Phase.CONFIRMATION else Phase.QUESTION
            if (text.isBlank()) return Action.Wake
        } else if (phase == Phase.QUESTION || phase == Phase.CONFIRMATION) {
            text = WakePhrase.question(text) ?: text
        }
        val compact = compact(text)
        return when (phase) {
            Phase.QUESTION, Phase.CONFIRMATION -> {
                if (compact.isEmpty() || compact == "까치야") return Action.Ignore
                val confirming = phase == Phase.CONFIRMATION
                phase = Phase.BUSY
                when {
                    compact in cancelled -> Action.Cancel
                    compact in repeated -> Action.Repeat
                    confirming && compact in confirmed -> Action.Confirm(true)
                    confirming -> Action.ClarifyConfirmation
                    else -> Action.Question(text.take(300))
                }
            }
            else -> Action.Ignore
        }
    }
    companion object {
        fun compact(text: String) = text.replace(Regex("[\\s.!?。！？,]"), "")
        val confirmed = setOf("확인", "실행", "확인해줘", "등록해", "진행해", "네", "예", "응", "맞아", "맞아요")
        val cancelled = setOf("취소", "취소해줘", "아니", "아니요", "그만", "중지")
        val repeated = setOf("다시읽어줘", "다시말해줘", "다시읽기")
    }
}

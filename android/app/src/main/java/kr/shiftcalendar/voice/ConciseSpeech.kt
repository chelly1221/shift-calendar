package kr.shiftcalendar.voice

/** Remove legacy boilerplate without dropping any requested items. */
object ConciseSpeech {
    fun forDisplay(raw: String, status: String): String {
        var text = raw.trim()
            .replace("내용이 맞으면 “확인”이라고 말하거나 실행 버튼을 누르세요. 취소할 수도 있습니다.", "확인 또는 취소라고 말씀해 주세요.")
            .replace(" PC 화면에 반영했습니다. Google 반영은 기존 동기화 설정에 따라 진행됩니다.", "")
        if (status != "ANSWER") return text
        val lines = text.lines().map(String::trim).filter(String::isNotEmpty).toMutableList()
        if (lines.size > 1 && (lines[0].endsWith("현재 조원 설정과 등록된 배정 기준입니다.") || lines[0].endsWith("확보된 공휴일 기록 기준입니다."))) lines.removeAt(0)
        text = lines.joinToString("\n").replace(", PC에 등록된 ", " ")
        return text
    }

    fun format(raw: String, status: String): String = forDisplay(raw, status)
}

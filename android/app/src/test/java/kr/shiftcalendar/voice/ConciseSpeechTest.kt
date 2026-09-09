package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class ConciseSpeechTest {
    @Test fun rosterAnswerSkipsRepeatedSourceAndKeepsAbsences() {
        val answer = "9월 9일, 현재 조원 설정과 등록된 배정 기준입니다.\n9월 9일 야간 A조: 김하나, 이둘(연차, 부재)"
        assertEquals("9월 9일 야간 A조: 김하나, 이둘(연차, 부재)", ConciseSpeech.format(answer, "ANSWER"))
        assertEquals("9월 9일 야간 A조: 김하나, 이둘(연차, 부재)", ConciseSpeech.forDisplay(answer, "ANSWER"))
    }

    @Test fun savedAnswerOmitsUnaskedSyncExplanation() {
        assertEquals("회의 일정을 등록했습니다.", ConciseSpeech.format("회의 일정을 등록했습니다. PC 화면에 반영했습니다. Google 반영은 기존 동기화 설정에 따라 진행됩니다.", "ANSWER"))
    }

    @Test fun destructiveConfirmationKeepsDateAndScope() {
        val scope = "9월 10일 회의: 삭제\n적용 범위: 전체 반복 일정\n"
        assertEquals(scope + "확인 또는 취소라고 말씀해 주세요.", ConciseSpeech.format(scope + "내용이 맞으면 “확인”이라고 말하거나 실행 버튼을 누르세요. 취소할 수도 있습니다.", "PREVIEW"))
        val unavailable = "처리 결과를 확인하지 못했습니다. 다시 확인이라고 말해 주세요."
        assertEquals(unavailable, ConciseSpeech.format(unavailable, "UNAVAILABLE"))
    }

    @Test fun longListsAreReadInFull() {
        val lines = (1..8).map { ("9월 ${it}일 교육: " + "교육 대상자 목록 ".repeat(6)).trimEnd() }
        val speech = ConciseSpeech.format(lines.joinToString("\n"), "ANSWER")
        assertEquals(lines.joinToString("\n"), speech)
        assertEquals(lines.joinToString("\n"), ConciseSpeech.forDisplay(lines.joinToString("\n"), "ANSWER"))
    }

    @Test fun conciseRosterIsIdenticalOnScreenAndInSpeech() {
        val answer = "일근 오지수\n주간 A조 김민수 이지원\n야간 B조 박지훈 최서연"
        assertEquals(answer, ConciseSpeech.forDisplay(answer, "ANSWER"))
        assertEquals(answer, ConciseSpeech.format(answer, "ANSWER"))
    }

    @Test fun longConfirmationIsNeverTruncated() {
        val preview = "9월 10일 회의 삭제\n" + "확인할 일정 내용\n".repeat(40) + "적용 범위: 전체 반복 일정\n확인 또는 취소라고 말씀해 주세요."
        assertEquals(preview, ConciseSpeech.forDisplay(preview, "PREVIEW"))
        assertEquals(preview, ConciseSpeech.format(preview, "PREVIEW"))
    }
}

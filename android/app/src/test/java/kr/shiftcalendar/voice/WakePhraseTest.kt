package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class WakePhraseTest {
    @Test fun extractsTheWholeQuestionFromOneUtterance() {
        for (text in listOf("까치야 내일 근무자 누구야?", "까치야, 내일 근무자 누구야?", "까치야내일 근무자 누구야?", "까치 야 내일 근무자 누구야?", "까 치 야 내일 근무자 누구야?")) {
            assertEquals("내일 근무자 누구야?", WakePhrase.question(text))
        }
    }
    @Test fun dropsWordsBeforeTheInvocationAndPreservesQuestionDetails() {
        assertEquals("9월 15일 김민수 교육 몇 시야?", WakePhrase.question("오늘 뭐 먹지 까치야 9월 15일 김민수 교육 몇 시야?"))
        assertEquals("가장 가까운 교육 언제야?", WakePhrase.question("까치야 가장 가까운 교육 언제야?"))
    }
    @Test fun distinguishesWakeAloneFromNoInvocation() {
        assertEquals("", WakePhrase.question("까치야!"))
        for (text in listOf("", "내일 회의 삭제해줘", "가치야 내일 근무", "같이야", "까치 이야기", "어디까지야", "아까치야")) {
            assertNull(WakePhrase.question(text))
        }
    }
    @Test fun mentioningTheWordIsNotAnInvocation() {
        for (text in listOf("까치야라는 단어", "‘까치야’라고 말해", "까치야 라고 불러", "까치야를 불러 봐")) {
            assertNull(WakePhrase.question(text))
        }
    }
}

package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class WakeDialogueTest {
    @Test fun combinedWakeAndQuestionSubmitOnceWithoutAnAnnouncementPhase() {
        val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.WAITING) }
        assertEquals(WakeDialogue.Action.Question("내일 근무자 누구야?"), dialogue.accept("까치야, 내일 근무자 누구야?"))
        assertEquals(WakeDialogue.Phase.BUSY, dialogue.phase)
        assertEquals(WakeDialogue.Action.Ignore, dialogue.accept("까치야, 내일 근무자 누구야?"))
        dialogue.enter(WakeDialogue.Phase.SPEAKING)
        assertEquals(WakeDialogue.Action.Ignore, dialogue.accept("까치야 내일 회의 삭제해줘"))
    }
    @Test fun wakeAloneSilentlyAcceptsTheNextQuestion() {
        val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.WAITING) }
        assertEquals(WakeDialogue.Action.Wake, dialogue.accept("까치야"))
        assertEquals(WakeDialogue.Phase.QUESTION, dialogue.phase)
        assertEquals(WakeDialogue.Action.Question("내일 야간 누구야"), dialogue.accept("내일 야간 누구야"))
    }
    @Test fun wakeAndConfirmationCannotBecomeANewEdit() {
        val dialogue = WakeDialogue()
        for ((text, expected) in listOf(
            "까치야 확인" to WakeDialogue.Action.Confirm(true),
            "까치야 취소" to WakeDialogue.Action.Cancel,
            "까치야 내일 회의 삭제해줘" to WakeDialogue.Action.ClarifyConfirmation
        )) {
            dialogue.enter(WakeDialogue.Phase.WAITING)
            assertEquals(expected, dialogue.accept(text, confirmingWake = true))
        }
        dialogue.enter(WakeDialogue.Phase.CONFIRMATION)
        assertEquals(WakeDialogue.Action.Confirm(true), dialogue.accept("까치야 확인"))
    }
    @Test fun ambientSpeechNeverRunsCommands() {
        val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.WAITING) }
        for (text in listOf("내일 회의 삭제해줘", "확인", "까치", "가치야", "까치야라는 단어")) assertEquals(WakeDialogue.Action.Ignore, dialogue.accept(text))
        assertEquals(WakeDialogue.Action.Wake, dialogue.accept("까치 야"))
        assertEquals(WakeDialogue.Action.Ignore, dialogue.accept("까치야"))
    }
    @Test fun questionCanOnlyRunOnceAndTtsCannotTriggerIt() {
        val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.QUESTION) }
        assertEquals(WakeDialogue.Action.Question("내일 야간 누구야"), dialogue.accept("내일 야간 누구야"))
        assertEquals(WakeDialogue.Action.Ignore, dialogue.accept("내일 야간 누구야"))
        dialogue.enter(WakeDialogue.Phase.SPEAKING)
        assertEquals(WakeDialogue.Action.Ignore, dialogue.accept("확인"))
    }
    @Test fun confirmationNeverFallsThroughIntoANewCommand() {
        for (word in listOf("확인", "네.", "맞아요")) {
            val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.CONFIRMATION) }
            assertEquals(WakeDialogue.Action.Confirm(true), dialogue.accept(word))
        }
        val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.CONFIRMATION) }
        assertEquals(WakeDialogue.Action.ClarifyConfirmation, dialogue.accept("내일 회의 삭제해줘"))
    }
    @Test fun cancellationAndReplayAreExplicit() {
        val dialogue = WakeDialogue().apply { enter(WakeDialogue.Phase.CONFIRMATION) }
        assertEquals(WakeDialogue.Action.Cancel, dialogue.accept("취소!"))
        dialogue.enter(WakeDialogue.Phase.QUESTION)
        assertEquals(WakeDialogue.Action.Repeat, dialogue.accept("다시 읽어줘"))
        dialogue.enter(WakeDialogue.Phase.STOPPED)
        assertEquals(WakeDialogue.Action.Ignore, dialogue.accept("까치야"))
    }
}

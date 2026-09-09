package kr.shiftcalendar.voice

import org.junit.Assert.*
import org.junit.Test

class VoiceScreenLayoutTest {
    @Test fun phoneAndSplitScreenUseOneColumn() {
        for (width in listOf(320, 360, 412, 599)) {
            val layout = VoiceScreenLayout(width, width)
            assertFalse(layout.tablet)
            assertTrue(layout.stackedActions)
            assertEquals(16, layout.pagePadding)
        }
    }

    @Test fun tabletStartsAt600AndRetainsRoomForAnswers() {
        val narrow = VoiceScreenLayout(600, 600)
        assertTrue(narrow.tablet)
        assertTrue(narrow.stackedActions)
        assertEquals(224, narrow.sidebarWidth)
        assertTrue(VoiceScreenLayout(1000, 800).tablet)
        assertFalse(VoiceScreenLayout(1000, 800).stackedActions)
    }

    @Test fun largerFontsStackActionsOnWideScreens() {
        assertTrue(VoiceScreenLayout(1000, 800, 1.5f).stackedActions)
        assertFalse(VoiceScreenLayout(1000, 800, 1f).stackedActions)
    }

    @Test fun aPhoneRemainsOneColumnWhenRotated() {
        assertFalse(VoiceScreenLayout(412, 412).tablet)
        assertFalse(VoiceScreenLayout(850, 412).tablet)
    }

    @Test fun aTabletUsesOneColumnInNarrowSplitScreen() {
        assertTrue(VoiceScreenLayout(850, 800).tablet)
        assertFalse(VoiceScreenLayout(450, 800).tablet)
    }
}

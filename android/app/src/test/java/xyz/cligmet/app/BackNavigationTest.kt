package xyz.cligmet.app

import org.junit.Assert.assertEquals
import org.junit.Test

class BackNavigationTest {
    @Test
    fun historyUsesWebBack() {
        assertEquals(BackAction.WEB_BACK, BackNavigation.decide(canGoBack = true))
    }

    @Test
    fun noHistoryFinishesActivity() {
        assertEquals(BackAction.FINISH, BackNavigation.decide(canGoBack = false))
    }
}

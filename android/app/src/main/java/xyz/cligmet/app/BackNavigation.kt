package xyz.cligmet.app

enum class BackAction {
    WEB_BACK,
    FINISH
}

object BackNavigation {
    fun decide(canGoBack: Boolean): BackAction =
        if (canGoBack) BackAction.WEB_BACK else BackAction.FINISH
}

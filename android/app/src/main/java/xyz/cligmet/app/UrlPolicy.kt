package xyz.cligmet.app

import java.net.URI

enum class NavigationDecision {
    INTERNAL,
    EXTERNAL,
    BLOCKED
}

object UrlPolicy {
    private const val CLIGMET_HOST = "cligmet.xyz"

    fun classify(value: String): NavigationDecision {
        val uri = try {
            URI(value)
        } catch (_: Exception) {
            return NavigationDecision.BLOCKED
        }

        val scheme = uri.scheme?.lowercase() ?: return NavigationDecision.BLOCKED
        val host = uri.host?.lowercase()

        return when {
            scheme == "https" && host == CLIGMET_HOST && (uri.port == -1 || uri.port == 443) ->
                NavigationDecision.INTERNAL
            scheme == "https" ->
                NavigationDecision.EXTERNAL
            scheme == "mailto" || scheme == "tel" ->
                NavigationDecision.EXTERNAL
            else ->
                NavigationDecision.BLOCKED
        }
    }
}

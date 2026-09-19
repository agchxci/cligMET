package xyz.cligmet.app

import org.junit.Assert.assertEquals
import org.junit.Test

class UrlPolicyTest {
    @Test
    fun cligmetHttpsIsInternal() {
        assertEquals(
            NavigationDecision.INTERNAL,
            UrlPolicy.classify("https://cligmet.xyz/forecast")
        )
    }

    @Test
    fun deceptiveCligmetHostnameIsExternal() {
        assertEquals(
            NavigationDecision.EXTERNAL,
            UrlPolicy.classify("https://cligmet.xyz.evil.example/")
        )
    }

    @Test
    fun otherHttpsHostIsExternal() {
        assertEquals(
            NavigationDecision.EXTERNAL,
            UrlPolicy.classify("https://example.com/")
        )
    }

    @Test
    fun mailtoAndTelAreExternal() {
        assertEquals(NavigationDecision.EXTERNAL, UrlPolicy.classify("mailto:test@example.com"))
        assertEquals(NavigationDecision.EXTERNAL, UrlPolicy.classify("tel:+441234567890"))
    }

    @Test
    fun cleartextUnknownAndMalformedSchemesAreBlocked() {
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify("http://cligmet.xyz/"))
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify("javascript:alert(1)"))
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify("file:///etc/passwd"))
        assertEquals(NavigationDecision.BLOCKED, UrlPolicy.classify("https://%zz"))
    }
}

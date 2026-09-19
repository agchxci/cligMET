package xyz.cligmet.app

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CligmetWebViewClientTest {
    @Test
    fun internalHttpsStaysInWebView() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)
        val client = CligmetWebViewClient(activity)

        assertFalse(client.shouldOverrideUrlLoading(
            webView,
            TestWebResourceRequest(Uri.parse("https://cligmet.xyz/forecast"))
        ))
    }

    @Test
    fun externalAndDeceptiveHostsLeaveWebView() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)
        val client = CligmetWebViewClient(activity)

        assertTrue(client.shouldOverrideUrlLoading(
            webView,
            TestWebResourceRequest(Uri.parse("https://example.com/"))
        ))
        assertTrue(client.shouldOverrideUrlLoading(
            webView,
            TestWebResourceRequest(Uri.parse("https://cligmet.xyz.evil.example/"))
        ))
    }

    @Test
    fun cleartextAndJavascriptAreBlocked() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)
        val client = CligmetWebViewClient(activity)

        assertTrue(client.shouldOverrideUrlLoading(
            webView,
            TestWebResourceRequest(Uri.parse("http://cligmet.xyz/"))
        ))
        assertTrue(client.shouldOverrideUrlLoading(
            webView,
            TestWebResourceRequest(Uri.parse("javascript:alert(1)"))
        ))
    }

    @Test
    fun sslErrorsAreAlwaysCancelled() {
        var cancelled = false
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val client = CligmetWebViewClient(activity)

        client.cancelSslError { cancelled = true }

        assertTrue(cancelled)
    }

    private class TestWebResourceRequest(
        private val target: Uri
    ) : WebResourceRequest {
        override fun getUrl(): Uri = target
        override fun isForMainFrame(): Boolean = true
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = true
        override fun getMethod(): String = "GET"
        override fun getRequestHeaders(): MutableMap<String, String> = mutableMapOf()
    }
}

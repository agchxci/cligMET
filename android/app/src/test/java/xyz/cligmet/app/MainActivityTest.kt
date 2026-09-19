package xyz.cligmet.app

import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.Shadows

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MainActivityTest {
    @Test
    fun webViewUsesRequiredSecuritySettings() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)

        assertTrue(webView.settings.javaScriptEnabled)
        assertTrue(webView.settings.domStorageEnabled)
        assertFalse(webView.settings.allowFileAccess)
        assertFalse(webView.settings.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, webView.settings.mixedContentMode)
    }

    @Test
    fun errorStateCanReplaceAndRestoreWebContent() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)
        val errorPanel = activity.findViewById<View>(R.id.errorPanel)

        activity.showError()
        assertEquals(View.GONE, webView.visibility)
        assertEquals(View.VISIBLE, errorPanel.visibility)

        activity.showWebContent()
        assertEquals(View.VISIBLE, webView.visibility)
        assertEquals(View.GONE, errorPanel.visibility)
    }

    @Test
    fun retryButtonLoadsStartUrl() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = activity.findViewById<WebView>(R.id.webView)
        activity.showError()

        activity.findViewById<Button>(R.id.retryButton).performClick()

        assertEquals(MainActivity.START_URL, Shadows.shadowOf(webView).lastLoadedUrl)
    }

    @Test
    fun activityRecreationKeepsSingleUsableWebView() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        controller.recreate()
        val activity = controller.get()

        val root = activity.findViewById<android.view.ViewGroup>(R.id.root)
        val webViews = (0 until root.childCount)
            .map { root.getChildAt(it) }
            .filterIsInstance<WebView>()

        assertEquals(1, webViews.size)
        assertEquals(View.VISIBLE, webViews.single().visibility)
    }
}

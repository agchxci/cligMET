package xyz.cligmet.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button

class MainActivity : Activity() {
    companion object {
        const val START_URL = "https://cligmet.xyz"
    }

    private lateinit var webView: WebView
    private lateinit var errorPanel: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        errorPanel = findViewById(R.id.errorPanel)

        configureWebView()

        findViewById<Button>(R.id.retryButton).setOnClickListener {
            showWebContent()
            webView.loadUrl(START_URL)
        }

        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        if (!restored) {
            webView.loadUrl(START_URL)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        webView.webViewClient = CligmetWebViewClient(this)
    }

    fun showError() {
        webView.visibility = View.GONE
        errorPanel.visibility = View.VISIBLE
    }

    fun showWebContent() {
        errorPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Platform callback retained for minSdk 26 compatibility")
    override fun onBackPressed() {
        when (BackNavigation.decide(webView.canGoBack())) {
            BackAction.WEB_BACK -> webView.goBack()
            BackAction.FINISH -> super.onBackPressed()
        }
    }
}

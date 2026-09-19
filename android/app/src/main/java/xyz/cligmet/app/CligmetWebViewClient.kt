package xyz.cligmet.app

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.http.SslError
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

class CligmetWebViewClient(
    private val activity: MainActivity
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(
        view: WebView,
        request: WebResourceRequest
    ): Boolean {
        return when (UrlPolicy.classify(request.url.toString())) {
            NavigationDecision.INTERNAL -> false
            NavigationDecision.EXTERNAL -> {
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                    activity.showError()
                }
                true
            }
            NavigationDecision.BLOCKED -> true
        }
    }

    override fun onPageStarted(
        view: WebView,
        url: String?,
        favicon: android.graphics.Bitmap?
    ) {
        activity.showWebContent()
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
    ) {
        if (request.isForMainFrame) {
            activity.showError()
        }
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest,
        errorResponse: WebResourceResponse
    ) {
        if (request.isForMainFrame && errorResponse.statusCode >= 400) {
            activity.showError()
        }
    }

    override fun onReceivedSslError(
        view: WebView,
        handler: SslErrorHandler,
        error: SslError
    ) {
        cancelSslError(handler::cancel)
        activity.showError()
    }

    internal fun cancelSslError(cancel: () -> Unit) {
        cancel()
    }
}

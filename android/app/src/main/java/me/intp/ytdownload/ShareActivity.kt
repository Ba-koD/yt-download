package me.intp.ytdownload

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 공유 시트 진입점 = 구간 모달. singleTask 라 연속 공유가 쌓이지 않고,
 * 두 번째 공유는 onNewIntent 로 받아 같은 화면을 다시 채운다.
 *
 * file:// 대신 WebViewAssetLoader — https 오리진이라 ES 모듈·secure context 가 되고,
 * 로컬 HTTP 서버(모든 앱에 무권한 노출)를 띄우지 않는다.
 */
class ShareActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
            }
            addJavascriptInterface(MobileBridge(applicationContext) { finish() }, "app")
        }
        setContentView(web)

        Engine.push = { msg -> runOnUiThread { pushToJs(msg) } }
        // 모달이 뜨는 동안 미리 초기화해 두면 probe 체감이 빨라진다
        Engine.scope.launch { runCatching { Engine.ensureReady(applicationContext) } }

        handleShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShare(intent)
    }

    override fun onDestroy() {
        Engine.push = null
        super.onDestroy()
    }

    private fun handleShare(intent: Intent) {
        val parsed = YouTubeLink.parse(intent.getStringExtra(Intent.EXTRA_TEXT))
        if (parsed == null) {
            Toast.makeText(this, "유튜브 링크가 아닙니다", Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        val t = parsed.startSec?.let { "&t=$it" } ?: ""
        web.loadUrl(
            "https://appassets.androidplatform.net/assets/mobile.html#v=${parsed.videoId}$t",
        )
    }

    private fun pushToJs(msg: JSONObject) {
        web.evaluateJavascript("window.__push($msg)", null)
    }
}

package me.intp.ytdownload

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * 유튜브 로그인 화면. 로그인 쿠키(SAPISID)가 생기는 순간
 * cookies.txt 로 내보내고 닫는다. 비공개·연령제한 영상에만 필요하다.
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // 구글이 WebView 로그인을 "안전하지 않은 브라우저"로 막는 것 우회:
            // UA 에서 webview 표식(; wv)만 지운다
            settings.userAgentString = settings.userAgentString.replace("; wv", "")
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                    maybeFinish(url)
                }
                override fun onPageFinished(view: WebView, url: String) {
                    maybeFinish(url)
                }
            }
        }
        setContentView(web)
        web.loadUrl(
            "https://accounts.google.com/ServiceLogin?service=youtube" +
                "&continue=https%3A%2F%2Fm.youtube.com%2F",
        )
    }

    /** 유튜브로 돌아왔고 로그인 쿠키가 있으면 굳히고 끝낸다. */
    private fun maybeFinish(url: String) {
        if (!url.contains("youtube.com")) return
        val cookies = CookieManager.getInstance().getCookie("https://www.youtube.com") ?: return
        if (!cookies.contains("SAPISID")) return
        CookieManager.getInstance().flush()
        val authed = CookieJar.export(applicationContext)
        Toast.makeText(
            this,
            if (authed) "로그인 완료" else "쿠키 저장 실패 — 다시 시도해주세요",
            Toast.LENGTH_SHORT,
        ).show()
        if (authed) finish()
    }
}

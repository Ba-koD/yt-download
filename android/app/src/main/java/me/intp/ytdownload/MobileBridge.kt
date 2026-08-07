package me.intp.ytdownload

import android.content.Context
import android.util.Log
import android.webkit.JavascriptInterface
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * WebView JS 브리지. HTTP 서버 대신 이걸로 직접 부른다 —
 * 127.0.0.1 서버는 폰의 모든 앱에 무권한 노출되므로 쓰지 않는다.
 *
 * 비동기 호출 규약: JS 가 cbId 를 넘기면 결과는
 * window.__push({type:"result", cbId, ok, data|error}) 로 돌아간다.
 * 진행률은 {type:"job", job:{…}} 으로 수시 푸시.
 */
class MobileBridge(
    private val ctx: Context,
    private val onClose: () -> Unit,
) {

    @JavascriptInterface
    fun close() = onClose()

    @JavascriptInterface
    fun probe(url: String, cbId: String) {
        Engine.scope.launch {
            try {
                resolve(cbId, Engine.probe(ctx, url))
            } catch (t: Throwable) {
                Log.w("Bridge", "probe failed", t)
                reject(cbId, t.message ?: "probe failed")
            }
        }
    }

    @JavascriptInterface
    fun openLogin() {
        ctx.startActivity(
            android.content.Intent(ctx, LoginActivity::class.java)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** 즉시 jobId 반환, 진행은 푸시로. est 는 UI 가 잰 예상 용량(바이트). */
    @JavascriptInterface
    fun start(
        url: String,
        startSec: String,
        endSec: String,
        quality: String,
        title: String,
        est: String,
    ): String = Engine.start(
        ctx, url, startSec.toLong(), endSec.toLongOrNull(), quality, title,
        est.toLongOrNull() ?: 0,
    )

    @JavascriptInterface
    fun cancel(jobId: String) = Engine.cancel(jobId)

    @JavascriptInterface
    fun jobs(): String = Engine.jobsJson()

    @JavascriptInterface
    fun authState(): String = """{"loggedIn":${CookieJar.exists(ctx)}}"""

    private fun resolve(cbId: String, data: JSONObject) {
        Engine.push?.invoke(
            JSONObject().put("type", "result").put("cbId", cbId)
                .put("ok", true).put("data", data),
        )
    }

    private fun reject(cbId: String, error: String) {
        Engine.push?.invoke(
            JSONObject().put("type", "result").put("cbId", cbId)
                .put("ok", false).put("error", error)
                .put("authError", Engine.isAuthError(error)),
        )
    }
}

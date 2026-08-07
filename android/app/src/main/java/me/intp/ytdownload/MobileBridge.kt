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

    /** 즉시 jobId 반환, 진행은 푸시로. */
    @JavascriptInterface
    fun start(url: String, startSec: String, endSec: String, quality: String): String =
        Engine.start(ctx, url, startSec.toLong(), endSec.toLongOrNull(), quality)

    @JavascriptInterface
    fun cancel(jobId: String) = Engine.cancel(jobId)

    @JavascriptInterface
    fun jobs(): String = Engine.jobsJson()

    /** 4단계에서 쿠키 상태로 대체된다. */
    @JavascriptInterface
    fun authState(): String = """{"loggedIn":false}"""

    private fun resolve(cbId: String, data: JSONObject) {
        Engine.push?.invoke(
            JSONObject().put("type", "result").put("cbId", cbId)
                .put("ok", true).put("data", data),
        )
    }

    private fun reject(cbId: String, error: String) {
        Engine.push?.invoke(
            JSONObject().put("type", "result").put("cbId", cbId)
                .put("ok", false).put("error", error),
        )
    }
}

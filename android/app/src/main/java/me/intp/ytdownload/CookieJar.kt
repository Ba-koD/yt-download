package me.intp.ytdownload

import android.content.Context
import android.webkit.CookieManager
import java.io.File

/**
 * 앱 안 WebView 로그인에서 나온 쿠키를 Netscape cookies.txt 로 굳힌다.
 * 다른 앱(크롬 등)의 쿠키는 어차피 못 읽는다 — 그래서 앱 안에서 로그인시킨다.
 */
object CookieJar {

    fun file(ctx: Context): File = File(ctx.filesDir, "cookies.txt")

    fun exists(ctx: Context): Boolean = file(ctx).exists()

    /**
     * WebView 쿠키 저장소를 내보낸다.
     * @return 로그인 쿠키(SAPISID)가 실제로 있었는지
     */
    fun export(ctx: Context): Boolean {
        val cm = CookieManager.getInstance()
        // getCookie 는 도메인·만료를 안 알려준다 — 도메인은 조회 URL 기준으로 적고
        // 만료는 먼 미래로 둔다 (yt-dlp 는 값만 쓴다)
        val sources = linkedMapOf(
            ".youtube.com" to "https://www.youtube.com",
            ".google.com" to "https://www.google.com",
            "accounts.google.com" to "https://accounts.google.com",
        )
        val seen = HashSet<String>()
        val sb = StringBuilder("# Netscape HTTP Cookie File\n")
        var authed = false
        for ((domain, url) in sources) {
            val raw = cm.getCookie(url) ?: continue
            for (part in raw.split("; ", ";")) {
                val i = part.indexOf('=')
                if (i <= 0) continue
                val name = part.substring(0, i).trim()
                val value = part.substring(i + 1)
                if (!seen.add("$domain/$name")) continue
                if (name == "SAPISID" || name == "__Secure-3PAPISID") authed = true
                sb.append("$domain\tTRUE\t/\tTRUE\t2147483647\t$name\t$value\n")
            }
        }
        file(ctx).writeText(sb.toString())
        return authed
    }

    fun clear(ctx: Context) {
        file(ctx).delete()
    }
}

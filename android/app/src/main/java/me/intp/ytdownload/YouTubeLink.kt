package me.intp.ytdownload

import java.net.URLDecoder

/**
 * 공유 텍스트에서 유튜브 영상을 식별한다.
 *
 * 유튜브 공유는 EXTRA_TEXT 에 제목을 붙여 보낼 때가 있어서
 * 문자열 전체를 URL 로 다루면 안 된다 — 먼저 URL 만 도려낸다.
 *
 * 처리하는 형태:
 *   youtu.be/ID · watch?v=ID · shorts/ID · live/ID · embed/ID · m.youtube.com/…
 * 시작 시각: t 또는 start 파라미터 (쿼리·프래그먼트), 90 / 90s / 1h2m3s 전부.
 */
object YouTubeLink {

    data class Parsed(
        val videoId: String,
        /** 공유 시점의 재생 위치. 없으면 null — 모달 시작 핸들의 초기값. */
        val startSec: Long?,
    ) {
        val watchUrl: String get() = "https://www.youtube.com/watch?v=$videoId"
    }

    private val URL_IN_TEXT = Regex("""https?://\S*(?:youtu\.be|youtube\.com)\S*""")
    private const val ID = """([A-Za-z0-9_-]{11})"""
    private val PATH_ID = Regex("""(?:youtu\.be/|/shorts/|/live/|/embed/|/v/)$ID""")
    private val QUERY_V = Regex("""[?&]v=$ID""")
    private val TIME_PARAM = Regex("""[?&#](?:t|start)=([0-9hms]+)""")
    private val HMS = Regex("""^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$""")

    fun parse(sharedText: String?): Parsed? {
        if (sharedText.isNullOrBlank()) return null
        val url = URL_IN_TEXT.find(sharedText)?.value ?: return null

        val id = QUERY_V.find(url)?.groupValues?.get(1)
            ?: PATH_ID.find(url)?.groupValues?.get(1)
            ?: return null

        val startSec = TIME_PARAM.find(url)?.groupValues?.get(1)?.let { parseTime(it) }
        return Parsed(id, startSec)
    }

    /** "90" · "90s" · "1h2m3s" · "2m10s" → 초. 해석 불가면 null. */
    fun parseTime(raw: String): Long? {
        val v = URLDecoder.decode(raw.trim(), "UTF-8")
        if (v.isEmpty()) return null
        v.toLongOrNull()?.let { return it }
        val m = HMS.matchEntire(v) ?: return null
        if (m.groupValues.drop(1).all { it.isEmpty() }) return null
        val (h, min, s) = m.destructured
        return (h.toLongOrNull() ?: 0) * 3600 +
            (min.toLongOrNull() ?: 0) * 60 +
            (s.toLongOrNull() ?: 0)
    }
}

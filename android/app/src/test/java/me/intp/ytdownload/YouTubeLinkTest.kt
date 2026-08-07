package me.intp.ytdownload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class YouTubeLinkTest {

    private fun id(text: String) = YouTubeLink.parse(text)?.videoId
    private fun start(text: String) = YouTubeLink.parse(text)?.startSec

    @Test fun `youtu_be 경로`() {
        assertEquals("aqz-KE-bpKQ", id("https://youtu.be/aqz-KE-bpKQ"))
    }

    @Test fun `watch 쿼리 v`() {
        assertEquals("aqz-KE-bpKQ", id("https://www.youtube.com/watch?v=aqz-KE-bpKQ"))
    }

    @Test fun `shorts 경로`() {
        assertEquals("aqz-KE-bpKQ", id("https://youtube.com/shorts/aqz-KE-bpKQ"))
    }

    @Test fun `live 경로`() {
        assertEquals("aqz-KE-bpKQ", id("https://www.youtube.com/live/aqz-KE-bpKQ"))
    }

    @Test fun `모바일 도메인`() {
        assertEquals("aqz-KE-bpKQ", id("https://m.youtube.com/watch?v=aqz-KE-bpKQ&pp=xyz"))
    }

    @Test fun `제목이 앞에 붙은 공유 텍스트`() {
        assertEquals(
            "aqz-KE-bpKQ",
            id("Big Buck Bunny 60fps 4K https://youtu.be/aqz-KE-bpKQ?si=abc123"),
        )
    }

    @Test fun `유튜브 아닌 링크는 거절`() {
        assertNull(id("https://vimeo.com/22439234"))
        assertNull(id("그냥 텍스트"))
        assertNull(id(""))
    }

    @Test fun `t 파라미터 - 초 단위 숫자`() {
        assertEquals(90L, start("https://youtu.be/aqz-KE-bpKQ?t=90"))
    }

    @Test fun `t 파라미터 - 90s 형태`() {
        assertEquals(90L, start("https://youtu.be/aqz-KE-bpKQ?t=90s"))
    }

    @Test fun `t 파라미터 - 1h2m3s 형태`() {
        assertEquals(3723L, start("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=1h2m3s"))
    }

    @Test fun `start 파라미터`() {
        assertEquals(120L, start("https://www.youtube.com/watch?v=aqz-KE-bpKQ&start=120"))
    }

    @Test fun `프래그먼트 t`() {
        assertEquals(45L, start("https://youtu.be/aqz-KE-bpKQ#t=45"))
    }

    @Test fun `부분 hms - 2m10s`() {
        assertEquals(130L, YouTubeLink.parseTime("2m10s"))
    }

    @Test fun `부분 hms - 1h`() {
        assertEquals(3600L, YouTubeLink.parseTime("1h"))
    }

    @Test fun `시각 없음`() {
        assertNull(start("https://youtu.be/aqz-KE-bpKQ"))
    }

    @Test fun `해석 불가 시각`() {
        assertNull(YouTubeLink.parseTime("abc"))
        assertNull(YouTubeLink.parseTime(""))
    }
}

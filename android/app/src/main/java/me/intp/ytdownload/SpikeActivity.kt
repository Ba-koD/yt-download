package me.intp.ytdownload

import android.os.Bundle
import android.util.Log
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDL.UpdateChannel
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * 0단계 스파이크. 화면은 로그 뷰 하나뿐이다.
 * 검증 항목:
 *  1. 라이브러리 초기화 (python + yt-dlp + ffmpeg 가 전부 포함되어 있는가)
 *  2. arm64-v8a 에서 실제 다운로드가 되는가
 *  3. --download-sections 가 통하는가 (10초 구간만 받아 파일 크기로 확인)
 */
class SpikeActivity : AppCompatActivity() {

    private lateinit var logView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        logView = TextView(this).apply {
            textSize = 12f
            setPadding(24, 48, 24, 48)
        }
        setContentView(ScrollView(this).apply { addView(logView) })

        CoroutineScope(Dispatchers.IO).launch { runSpike() }
    }

    private suspend fun say(msg: String) {
        Log.i(TAG, msg)
        withContext(Dispatchers.Main) {
            logView.append(msg + "\n")
            (logView.parent as ScrollView).post {
                (logView.parent as ScrollView).fullScroll(ScrollView.FOCUS_DOWN)
            }
        }
    }

    private suspend fun runSpike() {
        try {
            say("[1/5] YoutubeDL.init …")
            YoutubeDL.getInstance().init(applicationContext)
            say("[2/5] FFmpeg.init …")
            FFmpeg.getInstance().init(applicationContext)
            say("      yt-dlp version: " + YoutubeDL.getInstance().version(applicationContext))

            // 번들 yt-dlp 는 낡아서 최신 유튜브 nsig 챌린지를 못 푼다 (실측: 403).
            // 완료 조건 6번의 핵심 경로 — 갱신이 곧 복구다.
            say("[3/5] yt-dlp 갱신 (STABLE) …")
            val status = YoutubeDL.getInstance()
                .updateYoutubeDL(applicationContext, UpdateChannel.STABLE)
            say("      갱신 결과: $status, 버전: " +
                YoutubeDL.getInstance().version(applicationContext))

            val outDir = File(getExternalFilesDir(null), "spike").apply { mkdirs() }
            outDir.listFiles()?.forEach { it.delete() }

            say("[4/5] 구간 다운로드 시작 (1:00–1:10, 720p 이하)")
            val request = YoutubeDLRequest(TEST_URL).apply {
                addOption("--download-sections", "*00:01:00-00:01:10")
                addOption("--force-keyframes-at-cuts")
                addOption("-f", "bv*[height<=720]+ba/b[height<=720]")
                addOption("--no-mtime")
                addOption("-o", File(outDir, "spike.%(ext)s").absolutePath)
            }
            YoutubeDL.getInstance().execute(request, "spike") { progress, etaSec, line ->
                Log.i(TAG, "progress=$progress% eta=${etaSec}s | $line")
            }

            say("[5/5] 완료. 결과 파일:")
            val files = outDir.listFiles().orEmpty()
            if (files.isEmpty()) {
                say("      (없음 — 실패)")
            }
            files.forEach {
                say("      ${it.name}  ${it.length() / 1024} KB")
            }
            say("")
            say("판정: 10초 720p 구간이면 대략 1–5 MB 여야 한다.")
            say("수십 MB 면 --download-sections 가 무시된 것.")
        } catch (t: Throwable) {
            Log.e(TAG, "spike failed", t)
            say("실패: ${t::class.simpleName}: ${t.message}")
            say(Log.getStackTraceString(t))
        }
    }

    companion object {
        private const val TAG = "SPIKE"
        // Big Buck Bunny 공식 업로드 — 10분짜리, 로그인·연령제한 없음
        private const val TEST_URL = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"
    }
}

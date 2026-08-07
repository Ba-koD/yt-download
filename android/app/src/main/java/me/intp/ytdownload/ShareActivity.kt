package me.intp.ytdownload

import android.content.Intent
import android.os.Bundle
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * 공유 시트 진입점. singleTask 라 연속 공유가 쌓이지 않고,
 * 떠 있는 인스턴스로 오는 두 번째 공유는 onNewIntent 로 받는다.
 *
 * 지금은 파싱 결과를 화면에 보여주는 껍데기다 — 2단계에서 구간 모달로 바뀐다.
 */
class ShareActivity : AppCompatActivity() {

    private lateinit var view: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        view = TextView(this).apply {
            textSize = 16f
            setPadding(48, 96, 48, 96)
        }
        setContentView(view)
        handleShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShare(intent)
    }

    private fun handleShare(intent: Intent) {
        val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
        val parsed = YouTubeLink.parse(shared)
        if (parsed == null) {
            Toast.makeText(this, "유튜브 링크가 아닙니다", Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        view.text = buildString {
            appendLine("영상 ID: ${parsed.videoId}")
            appendLine("시작 시각: ${parsed.startSec?.let { "${it}초" } ?: "(없음)"}")
            appendLine()
            appendLine(parsed.watchUrl)
            appendLine()
            appendLine("(1단계 확인용 화면 — 2단계에서 구간 모달로 대체)")
        }
    }
}

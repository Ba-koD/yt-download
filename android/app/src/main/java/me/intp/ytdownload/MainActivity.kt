package me.intp.ytdownload

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * 런처 진입점 = 온보딩. 설치 직후 한 화면에서 끝내고 다시 묻지 않는다.
 * 평소 쓰임새는 공유 시트라 이 화면은 설정 확인용이다.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var notifRow: Button
    private lateinit var dozeRow: Button
    private lateinit var loginRow: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        fun button(text: String, onClick: () -> Unit) = Button(this).apply {
            this.text = text
            isAllCaps = false
            textSize = 15f
            setOnClickListener { onClick() }
        }

        notifRow = button("알림 권한") {
            if (Build.VERSION.SDK_INT >= 33) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
        dozeRow = button("앱 절전 예외") {
            // 삼성 등이 깊은 절전에 넣으면 공유 시트에서 아이콘이 사라진다
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName"),
                ),
            )
        }
        loginRow = button("유튜브 로그인") {
            startActivity(Intent(this, LoginActivity::class.java))
        }

        val explain = TextView(this).apply {
            textSize = 13f
            setPadding(8, 0, 8, 24)
            text = "유튜브 앱에서 공유 → yt-download 를 누르면 구간 선택 창이 뜹니다.\n" +
                "로그인은 비공개·연령제한 영상에만 필요합니다."
        }

        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(48, 96, 48, 48)
                addView(
                    TextView(context).apply { text = "yt-download"; textSize = 24f },
                    ViewGroup.LayoutParams(-1, -2),
                )
                addView(explain)
                addView(notifRow)
                addView(dozeRow)
                addView(loginRow)
            },
        )
    }

    override fun onResume() {
        super.onResume()
        val notifOk = Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        val dozeOk = getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(packageName)
        notifRow.text = if (notifOk) "✓ 알림 권한" else "알림 권한 허용하기"
        dozeRow.text = if (dozeOk) "✓ 앱 절전 예외" else "앱 절전 예외 설정하기"
        loginRow.text =
            if (CookieJar.exists(this)) "✓ 유튜브 로그인 (다시 로그인)" else "유튜브 로그인 (건너뛰어도 됨)"
    }
}

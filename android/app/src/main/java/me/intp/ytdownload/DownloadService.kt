package me.intp.ytdownload

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * 다운로드의 수명 앵커. 알림 없는 백그라운드 작업은 도즈에서 죽는다.
 * 실행 자체는 Engine 이 하고, 서비스는 포그라운드 유지 + 진행 알림 + 취소만 맡는다.
 * 부분 웨이크락은 서비스 수명(= 작업이 도는 동안)만 잡는다.
 */
class DownloadService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private val listener: (Engine.Job) -> Unit = { onJob(it) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "다운로드", NotificationManager.IMPORTANCE_LOW),
            )
        }
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ytdownload:job")
            .apply { acquire(60 * 60 * 1000L) }
        Engine.jobListeners.add(listener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            intent.getStringExtra(EXTRA_JOB)?.let { Engine.cancel(it) }
        }
        startForeground(NOTIF_ID, notification(Engine.firstRunning()))
        if (Engine.firstRunning() == null) stopSelf()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        Engine.jobListeners.remove(listener)
        wakeLock?.takeIf { it.isHeld }?.release()
        super.onDestroy()
    }

    private fun onJob(job: Engine.Job) {
        val running = Engine.firstRunning()
        if (running != null) {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIF_ID, notification(running))
        } else {
            // 마지막 작업 결과를 별도 알림으로 남기고 포그라운드를 내린다
            getSystemService(NotificationManager::class.java).notify(
                NOTIF_ID + 1,
                NotificationCompat.Builder(this, CHANNEL)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle(if (job.state == "done") "저장 완료" else "다운로드 실패")
                    .setContentText(job.file ?: job.error ?: job.title)
                    .setAutoCancel(true)
                    .build(),
            )
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun notification(job: Engine.Job?): android.app.Notification {
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(job?.title?.ifBlank { null } ?: "구간 다운로드")
            .setOnlyAlertOnce(true)
            .setOngoing(true)
        if (job != null) {
            val pct = job.pct.toInt()
            if (pct > 0) b.setProgress(100, pct, false) else b.setProgress(0, 0, true)
            b.setContentText(job.text?.trim() ?: "")
            val cancel = Intent(this, DownloadService::class.java)
                .setAction(ACTION_CANCEL).putExtra(EXTRA_JOB, job.id)
            b.addAction(
                0, "취소",
                PendingIntent.getService(
                    this, job.id.hashCode(), cancel,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        }
        return b.build()
    }

    companion object {
        private const val CHANNEL = "downloads"
        private const val NOTIF_ID = 1
        const val ACTION_CANCEL = "me.intp.ytdownload.CANCEL"
        const val EXTRA_JOB = "job"

        fun start(ctx: Context) {
            ContextCompat.startForegroundService(ctx, Intent(ctx, DownloadService::class.java))
        }
    }
}

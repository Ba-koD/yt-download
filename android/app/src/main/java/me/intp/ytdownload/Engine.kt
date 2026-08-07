package me.intp.ytdownload

import android.content.Context
import android.util.Log
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDL.UpdateChannel
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * yt-dlp 실행 계층. 액티비티 수명과 무관한 프로세스 전역이라
 * 회전·재진입에도 작업이 살아 있다 (3단계에서 포그라운드 서비스가 감싼다).
 *
 * 스파이크 실측: 번들 yt-dlp 는 이미 nsig 실패로 죽어 있었다.
 * 그래서 추출 실패 시 갱신 → 1회 재시도가 기본 경로다.
 */
object Engine {

    private const val TAG = "Engine"
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val initMutex = Mutex()
    @Volatile private var ready = false
    @Volatile private var updatedThisRun = false

    /** UI 로 밀어넣는 채널. ShareActivity 가 붙였다 뗀다. */
    @Volatile var push: ((JSONObject) -> Unit)? = null

    data class Job(
        val id: String,
        val url: String,
        val startSec: Long,
        val endSec: Long?,
        @Volatile var state: String = "running", // running | done | error | cancelled
        @Volatile var pct: Float = 0f,
        /** 구간 다운로드는 전체 크기를 몰라 pct 가 -1 인 채로 돈다 — 원시 진행 줄로 보완 */
        @Volatile var text: String? = null,
        @Volatile var file: String? = null,
        @Volatile var error: String? = null,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("url", url)
            .put("startSec", startSec).put("endSec", endSec ?: JSONObject.NULL)
            .put("state", state).put("pct", pct)
            .put("text", text ?: JSONObject.NULL)
            .put("file", file ?: JSONObject.NULL)
            .put("error", error ?: JSONObject.NULL)
    }

    private val jobs = ConcurrentHashMap<String, Job>()
    private var jobSeq = 0

    suspend fun ensureReady(ctx: Context) = initMutex.withLock {
        if (!ready) {
            YoutubeDL.getInstance().init(ctx)
            FFmpeg.getInstance().init(ctx)
            ready = true
        }
    }

    /** 프로세스당 1회 yt-dlp 갱신. 실패해도 조용히 넘어가되 로그는 남긴다. */
    private suspend fun updateOnce(ctx: Context): Boolean {
        initMutex.withLock {
            if (updatedThisRun) return false
            updatedThisRun = true
        }
        return runCatching {
            val st = YoutubeDL.getInstance().updateYoutubeDL(ctx, UpdateChannel.STABLE)
            Log.i(TAG, "yt-dlp update: $st -> ${YoutubeDL.getInstance().version(ctx)}")
            true
        }.getOrElse {
            Log.w(TAG, "yt-dlp update failed", it)
            false
        }
    }

    /** 제목·길이·썸네일. 추출 실패면 갱신 후 1회 재시도. */
    suspend fun probe(ctx: Context, url: String): JSONObject {
        ensureReady(ctx)
        val raw = try {
            dumpJson(url)
        } catch (e: Exception) {
            if (updateOnce(ctx)) dumpJson(url) else throw e
        }
        return JSONObject()
            .put("title", raw.optString("title"))
            .put("duration", raw.optDouble("duration", 0.0))
            .put("thumbnail", raw.optString("thumbnail"))
            .put("isLive", raw.optBoolean("is_live", false))
    }

    private fun dumpJson(url: String): JSONObject {
        val req = YoutubeDLRequest(url).apply {
            addOption("--dump-json")
            addOption("--no-warnings")
            addOption("--no-playlist")
        }
        val out = YoutubeDL.getInstance().execute(req, null, null).out
        return JSONObject(out.lineSequence().first { it.trimStart().startsWith("{") })
    }

    fun start(ctx: Context, url: String, startSec: Long, endSec: Long?, quality: String): String {
        val id = "job${++jobSeq}-${System.currentTimeMillis()}"
        val job = Job(id, url, startSec, endSec)
        jobs[id] = job
        scope.launch { run(ctx.applicationContext, job, quality) }
        return id
    }

    private suspend fun run(ctx: Context, job: Job, quality: String) {
        try {
            ensureReady(ctx)
            try {
                exec(ctx, job, quality)
            } catch (e: Exception) {
                if (job.state == "cancelled") throw e
                // 유튜브 추출 로직 변경 시나리오: 갱신하고 한 번만 다시
                if (updateOnce(ctx)) exec(ctx, job, quality) else throw e
            }
            if (job.state != "cancelled") {
                job.state = "done"
                emit(job)
            }
        } catch (t: Throwable) {
            if (job.state != "cancelled") {
                Log.e(TAG, "job ${job.id} failed", t)
                job.state = "error"
                job.error = t.message?.take(300) ?: t::class.simpleName
                emit(job)
            }
        }
    }

    private fun exec(ctx: Context, job: Job, quality: String) {
        val outDir = File(ctx.getExternalFilesDir(null), "downloads/${job.id}").apply { mkdirs() }
        val section = "*${job.startSec}-${job.endSec?.toString() ?: "inf"}"
        val req = YoutubeDLRequest(job.url).apply {
            addOption("--download-sections", section)
            addOption("--force-keyframes-at-cuts")
            addOption("-f", formatExpr(quality))
            addOption("--no-mtime")
            addOption("--no-playlist")
            addOption("-o", File(outDir, "%(title).80s [%(id)s].%(ext)s").absolutePath)
        }
        YoutubeDL.getInstance().execute(req, job.id) { pct, _, line ->
            job.pct = pct
            job.text = line.take(120)
            emit(job)
        }
        job.file = outDir.listFiles()?.maxByOrNull { it.length() }?.name
    }

    private fun formatExpr(quality: String): String = when (quality) {
        "1080" -> "bv*[height<=1080]+ba/b[height<=1080]"
        "720" -> "bv*[height<=720]+ba/b[height<=720]"
        "audio" -> "ba/b"
        else -> "bv*+ba/b"
    }

    fun cancel(id: String) {
        jobs[id]?.let {
            it.state = "cancelled"
            YoutubeDL.getInstance().destroyProcessById(id)
            emit(it)
        }
    }

    fun jobsJson(): String {
        val arr = org.json.JSONArray()
        jobs.values.sortedBy { it.id }.forEach { arr.put(it.toJson()) }
        return arr.toString()
    }

    private fun emit(job: Job) {
        push?.invoke(JSONObject().put("type", "job").put("job", job.toJson()))
    }
}

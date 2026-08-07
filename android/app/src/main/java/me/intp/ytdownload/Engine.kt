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

    /** 작업 이벤트 리스너 (서비스 알림용). */
    val jobListeners = java.util.concurrent.CopyOnWriteArrayList<(Job) -> Unit>()

    data class Job(
        val id: String,
        val url: String,
        val startSec: Long,
        val endSec: Long?,
        val title: String = "",
        @Volatile var state: String = "running", // running | done | error | cancelled
        @Volatile var pct: Float = 0f,
        /** 구간 다운로드는 전체 크기를 몰라 pct 가 -1 인 채로 돈다 — 원시 진행 줄로 보완 */
        @Volatile var text: String? = null,
        /** 출력 폴더 실측 바이트. 로그 줄 형식과 무관하게 정확하다. */
        @Volatile var bytes: Long = 0,
        @Volatile var file: String? = null,
        @Volatile var error: String? = null,
        @Volatile var authError: Boolean = false,
    ) {
        fun toJson(): JSONObject = JSONObject()
            .put("id", id).put("url", url)
            .put("startSec", startSec).put("endSec", endSec ?: JSONObject.NULL)
            .put("state", state).put("pct", pct)
            .put("bytes", bytes)
            .put("text", text ?: JSONObject.NULL)
            .put("file", file ?: JSONObject.NULL)
            .put("error", error ?: JSONObject.NULL)
            .put("authError", authError)
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

    /** 만료된 쿠키로 인한 실패를 판별한다 — 침묵하는 실패가 "1회 설치 후 방치"를 깨뜨린다. */
    fun isAuthError(msg: String?): Boolean = msg != null && listOf(
        "sign in", "log in", "login required", "private video",
        "members-only", "age", "cookies", "account",
    ).any { msg.contains(it, ignoreCase = true) }

    /** 제목·길이·썸네일. 추출 실패면 갱신 후 1회 재시도. */
    suspend fun probe(ctx: Context, url: String): JSONObject {
        ensureReady(ctx)
        val raw = try {
            dumpJson(ctx, url)
        } catch (e: Exception) {
            if (!isAuthError(e.message) && updateOnce(ctx)) dumpJson(ctx, url) else throw e
        }
        return JSONObject()
            .put("title", raw.optString("title"))
            .put("duration", raw.optDouble("duration", 0.0))
            .put("thumbnail", raw.optString("thumbnail"))
            .put("isLive", raw.optBoolean("is_live", false))
            .put("video", videoFormats(raw))
            .put("audio", audioFormats(raw))
    }

    /** 북마클릿 패널과 같은 화질 목록: mp4 영상 트랙, 해상도·주사율 내림차순. */
    private fun videoFormats(raw: JSONObject): org.json.JSONArray {
        val fmts = raw.optJSONArray("formats") ?: return org.json.JSONArray()
        data class V(val id: String, val h: Int, val fps: Int, val codec: String, val tbr: Double)
        val all = (0 until fmts.length()).mapNotNull { i ->
            val f = fmts.getJSONObject(i)
            val vcodec = f.optString("vcodec", "none")
            if (vcodec == "none" || f.optString("acodec", "none") != "none") return@mapNotNull null
            V(
                f.optString("format_id"),
                f.optInt("height", 0),
                f.optInt("fps", 0),
                vcodec,
                f.optDouble("tbr", 0.0),
            )
        }
        // 북마클릿처럼 mp4(H.264) 우선 — 폰 재생 호환이 제일 좋다. 없으면 전부.
        val pool = all.filter { it.codec.startsWith("avc1") }.ifEmpty { all }
        val best = pool.groupBy { it.h to it.fps }
            .mapValues { (_, v) -> v.maxBy { it.tbr } }.values
            .sortedWith(compareByDescending<V> { it.h }.thenByDescending { it.fps })
        val arr = org.json.JSONArray()
        best.forEach {
            val label = "${it.h}p${if (it.fps > 30) it.fps else ""} ${codecShort(it.codec)}"
            arr.put(JSONObject().put("id", it.id).put("label", label).put("tbr", it.tbr))
        }
        return arr
    }

    private fun audioFormats(raw: JSONObject): org.json.JSONArray {
        val fmts = raw.optJSONArray("formats") ?: return org.json.JSONArray()
        data class A(val id: String, val abr: Int, val codec: String, val tbr: Double)
        val all = (0 until fmts.length()).mapNotNull { i ->
            val f = fmts.getJSONObject(i)
            val acodec = f.optString("acodec", "none")
            if (acodec == "none" || f.optString("vcodec", "none") != "none") return@mapNotNull null
            val abr = f.optDouble("abr", 0.0)
            if (abr <= 0) return@mapNotNull null
            A(f.optString("format_id"), Math.round(abr).toInt(), acodec, f.optDouble("tbr", abr))
        }
        val pool = all.filter { it.codec.startsWith("mp4a") }.ifEmpty { all }
        val best = pool.groupBy { it.abr }
            .mapValues { (_, v) -> v.maxBy { it.tbr } }.values
            .sortedByDescending { it.abr }
        val arr = org.json.JSONArray()
        best.forEach {
            arr.put(
                JSONObject().put("id", it.id)
                    .put("label", "${it.abr}kbps ${codecShort(it.codec)}").put("tbr", it.tbr),
            )
        }
        return arr
    }

    private fun codecShort(codec: String): String = when {
        codec.startsWith("avc1") -> "H.264"
        codec.startsWith("av01") -> "AV1"
        codec.startsWith("vp9") || codec.startsWith("vp09") -> "VP9"
        codec.startsWith("mp4a") -> "AAC"
        codec.startsWith("opus") -> "Opus"
        else -> codec
    }

    private fun YoutubeDLRequest.withCookies(ctx: Context): YoutubeDLRequest {
        if (CookieJar.exists(ctx)) addOption("--cookies", CookieJar.file(ctx).absolutePath)
        return this
    }

    private fun dumpJson(ctx: Context, url: String): JSONObject {
        val req = YoutubeDLRequest(url).apply {
            addOption("--dump-json")
            addOption("--no-warnings")
            addOption("--no-playlist")
        }.withCookies(ctx)
        val out = YoutubeDL.getInstance().execute(req, null, null).out
        return JSONObject(out.lineSequence().first { it.trimStart().startsWith("{") })
    }

    fun start(
        ctx: Context,
        url: String,
        startSec: Long,
        endSec: Long?,
        quality: String,
        title: String,
    ): String {
        val id = "job${++jobSeq}-${System.currentTimeMillis()}"
        val job = Job(id, url, startSec, endSec, title)
        jobs[id] = job
        DownloadService.start(ctx)
        scope.launch { run(ctx.applicationContext, job, quality) }
        return id
    }

    fun firstRunning(): Job? = jobs.values.firstOrNull { it.state == "running" }

    private suspend fun run(ctx: Context, job: Job, quality: String) {
        try {
            ensureReady(ctx)
            try {
                exec(ctx, job, quality)
            } catch (e: Exception) {
                if (job.state == "cancelled" || isAuthError(e.message)) throw e
                // 유튜브 추출 로직 변경 시나리오: 갱신하고 한 번만 다시
                if (updateOnce(ctx)) exec(ctx, job, quality) else throw e
            }
            if (job.state != "cancelled") {
                job.file?.let { name ->
                    val src = File(
                        File(ctx.getExternalFilesDir(null), "downloads/${job.id}"),
                        name,
                    )
                    job.file = MediaSaver.publish(ctx, src)
                    src.parentFile?.deleteRecursively()
                }
                job.state = "done"
                emit(job)
            }
        } catch (t: Throwable) {
            if (job.state != "cancelled") {
                Log.e(TAG, "job ${job.id} failed", t)
                job.state = "error"
                job.authError = isAuthError(t.message)
                job.error =
                    if (job.authError) "로그인이 필요하거나 만료되었습니다"
                    else t.message?.take(300) ?: t::class.simpleName
                emit(job)
            }
        }
    }

    private suspend fun exec(ctx: Context, job: Job, quality: String) {
        val outDir = File(ctx.getExternalFilesDir(null), "downloads/${job.id}").apply { mkdirs() }
        val section = "*${job.startSec}-${job.endSec?.toString() ?: "inf"}"
        val req = YoutubeDLRequest(job.url).apply {
            addOption("--download-sections", section)
            addOption("--force-keyframes-at-cuts")
            addOption("-f", quality.ifBlank { "bv*+ba/b" })
            addOption("-N", "8") // DASH 조각 동시 다운로드 — 폰 회선에서 체감 차이가 크다
            addOption("--no-mtime")
            addOption("--no-playlist")
            addOption("-o", File(outDir, "%(title).80s [%(id)s].%(ext)s").absolutePath)
        }.withCookies(ctx)
        // 진행 줄 파싱은 형식이 바뀌면 깨진다 — 출력 폴더 크기를 직접 잰다
        val poller = scope.launch {
            while (true) {
                job.bytes = outDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
                emit(job)
                kotlinx.coroutines.delay(1000)
            }
        }
        try {
            YoutubeDL.getInstance().execute(req, job.id) { pct, _, line ->
                job.pct = pct
                job.text = line.take(120)
            }
        } finally {
            poller.cancel()
        }
        job.bytes = outDir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        job.file = outDir.listFiles()?.maxByOrNull { it.length() }?.name
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
        jobListeners.forEach { it(job) }
    }
}

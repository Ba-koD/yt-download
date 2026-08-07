package me.intp.ytdownload

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.MediaStore

import java.io.File

/**
 * 완성본을 MediaStore 로 공개 저장한다 — 권한 요청이 필요 없고 갤러리에 뜨며
 * 앱을 지워도 남는다. 쓰는 동안 IS_PENDING=1 로 미완성 파일 노출을 막는다.
 */
object MediaSaver {

    fun publish(ctx: Context, src: File): String? {
        if (!src.exists()) return null
        if (Build.VERSION.SDK_INT < 29) return src.name // MediaStore 상대경로 미지원 — 앱 폴더 유지

        val ext = src.extension.lowercase()
        val audio = ext in setOf("m4a", "mp3", "opus", "ogg", "oga", "flac", "wav", "aac")
        val mime = when (ext) {
            "mp4" -> "video/mp4"
            "webm" -> if (audio) "audio/webm" else "video/webm"
            "mkv" -> "video/x-matroska"
            "m4a" -> "audio/mp4"
            "mp3" -> "audio/mpeg"
            "opus", "ogg", "oga" -> "audio/ogg"
            else -> "application/octet-stream"
        }
        val collection =
            if (audio) MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            else MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        val dir = if (audio) "Music/yt-download" else "Movies/yt-download"

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, src.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val resolver = ctx.contentResolver
        val uri = resolver.insert(collection, values) ?: return null
        try {
            resolver.openOutputStream(uri)!!.use { out ->
                src.inputStream().use { it.copyTo(out) }
            }
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        } catch (t: Throwable) {
            resolver.delete(uri, null, null) // 미완성 파일을 갤러리에 남기지 않는다
            throw t
        }
        return src.name
    }
}

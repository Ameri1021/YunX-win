package com.yunx.desktop

import com.yunx.app.data.download.ChunkDownloader
import com.yunx.app.data.download.ChunkResult
import com.yunx.app.data.download.HlsDownloader
import com.yunx.app.data.network.HttpClients
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

/** Windows 任务独立于窗口生命周期；断点使用固定区间，避免跨会话弹性分片重叠。 */
class DownloadEngine(
    private val scope: CoroutineScope,
    private val emit: (String, JSONObject) -> Unit,
    private val cleanup: suspend (JSONObject) -> Unit
) {
    private class Task(val id: String, val spec: JSONObject, val path: File) {
        val control = Mutex()
        var job: Job? = null
        @Volatile var status = "paused"
        @Volatile var downloaded = 0L
        @Volatile var total = 0L
        @Volatile var speed = 0L
        @Volatile var error = ""
        val lastReport = AtomicLong(0)
        fun json(secret: Boolean = true) = JSONObject().put("id", id).put("name", path.name)
            .put("path", path.absolutePath).put("status", status).put("downloaded", downloaded)
            .put("total", total).put("speed", speed).put("error", error)
            .put("platform", spec.optString("platform", "generic"))
            .also { if (secret) it.put("spec", spec) }
    }
    private val tasks = ConcurrentHashMap<String, Task>()
    private val downloader = ChunkDownloader { HttpClients.downloadClient() }
    private val slots = Mutex()
    private val reservations = Mutex()
    private var running = 0
    @Volatile var threads = 8
    @Volatile var concurrency = 3
    @Volatile var speedLimit = 0L
    private val rateLock = Any()
    private var nextAllowed = 0L

    fun list() = tasks.values.sortedBy { it.id }.map { it.json() }

    suspend fun enqueue(spec: JSONObject, directory: String): JSONObject {
        requireHttp(spec.getString("url"))
        val dir = File(directory).canonicalFile.apply { mkdirs() }
        require(dir.isDirectory) { "下载目录不可用" }
        val id = UUID.randomUUID().toString()
        val name = safeName(spec.optString("fileName", "download"))
        val task = reservations.withLock {
            var destination = File(dir, name)
            var index = 1
            val stem = name.substringBeforeLast('.', name)
            val extension = name.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }
            while (destination.exists() || tasks.values.any { it.path == destination }) {
                destination = File(dir, "$stem (${index++})$extension")
            }
            Task(id, spec, destination).also { tasks[id] = it }
        }
        start(id)
        return task.json()
    }

    fun restore(values: List<JSONObject>) {
        values.forEach { value ->
            val id = value.optString("id")
            if (!Regex("[a-f0-9-]{36}").matches(id)) return@forEach
            val spec = value.optJSONObject("spec") ?: return@forEach
            val path = value.optString("path").takeIf { it.isNotBlank() } ?: return@forEach
            val task = Task(id, spec, File(path).canonicalFile)
            task.status = if (value.optString("status") == "completed" && task.path.exists()) "completed" else "paused"
            task.total = value.optLong("total")
            task.downloaded = if (task.status == "completed") task.total else value.optLong("downloaded")
            tasks[id] = task
        }
    }

    suspend fun start(id: String) {
        val task = tasks[id] ?: error("下载任务不存在")
        task.control.withLock {
            if (task.job?.isActive == true || task.status == "completed") return
            task.error = ""
            task.status = "queued"
            task.job = scope.launch(start = CoroutineStart.LAZY) {
                var acquired = false
                try {
                    while (!acquired) {
                        ensureActive()
                        acquired = slots.withLock {
                            if (running < concurrency.coerceIn(1, 5)) { running++; true } else false
                        }
                        if (!acquired) delay(150)
                    }
                    task.status = "downloading"
                    report(task, true)
                    run(task)
                    task.status = "completed"
                    task.speed = 0
                    task.downloaded = task.total
                    // 清理失败只影响云端临时目录，不反向破坏已完成的本地任务。
                    try { cleanup(task.spec) } catch (ce: CancellationException) { throw ce } catch (_: Exception) { }
                } catch (ce: CancellationException) {
                    if (task.status != "completed") task.status = "paused"
                    task.speed = 0
                    throw ce
                } catch (error: Exception) {
                    task.status = "failed"
                    task.speed = 0
                    task.error = error.message?.take(300) ?: "下载失败"
                } finally {
                    if (acquired) withContext(NonCancellable) { slots.withLock { running-- } }
                    report(task, true)
                }
            }
            report(task, true)
            task.job!!.start()
        }
    }

    suspend fun pause(id: String) {
        val task = tasks[id] ?: return
        task.control.withLock {
            downloader.cancelCalls(taskId(id))
            task.job?.cancelAndJoin()
            if (task.status != "completed") task.status = "paused"
            task.speed = 0
            report(task, true)
        }
    }

    suspend fun remove(id: String) {
        pause(id)
        val task = tasks.remove(id) ?: return
        partsDirectory(task).deleteRecursively()
        temporaryDestination(task).delete()
        emit("downloadRemoved", JSONObject().put("id", id))
    }

    suspend fun shutdown() { tasks.keys.toList().forEach { pause(it) } }

    private suspend fun run(task: Task) {
        val spec = task.spec
        val headers = spec.optJSONObject("headers")?.let { o -> o.keySet().associateWith { o.getString(it) } } ?: emptyMap()
        var url = spec.getString("url")
        val dir = partsDirectory(task).apply { mkdirs() }
        val target = temporaryDestination(task)
        try {
            if (spec.optBoolean("isHls")) {
                task.downloaded = 0
                val ok = HlsDownloader.download(url, headers, target) { bytes ->
                    throttle(bytes)
                    task.downloaded += bytes
                    report(task)
                }
                currentCoroutineContext().ensureActive()
                check(ok) { "HLS 下载失败，链接可能已过期或流格式不受支持" }
                task.total = target.length()
            } else {
                var remote = downloader.probe(url, headers, taskId(task.id))
                var total = remote?.size
                if (total == null && spec.optString("fallbackUrl").isNotBlank()) {
                    url = spec.getString("fallbackUrl")
                    requireHttp(url)
                    remote = downloader.probe(url, headers, taskId(task.id))
                    total = remote?.size
                }
                task.total = total ?: 0
                if (total == null || total <= 0) {
                    task.downloaded = 0
                    check(downloader.downloadFull(taskId(task.id), url, target, headers) { bytes ->
                        throttle(bytes); task.downloaded += bytes; report(task)
                    }) { "下载失败，请检查链接有效性和网络" }
                    task.total = target.length()
                } else {
                    val workerCount = min(threads.coerceIn(1, 32), if (spec.optString("platform") == "xunlei") 8 else 32)
                    val count = min(workerCount * 4, ((total + 1024 * 1024 - 1) / (1024 * 1024)).coerceAtLeast(1).toInt())
                    val slice = (total + count - 1) / count
                    val signature = "$total:$count:${sha256(url)}:${remote?.etag.orEmpty()}:${remote?.lastModified.orEmpty()}"
                    val plan = File(dir, "plan.txt")
                    if (plan.exists() && plan.readText() != signature) {
                        dir.deleteRecursively(); dir.mkdirs()
                    }
                    plan.writeText(signature)
                    val parts = (0 until count).map { i -> File(dir, "part_$i") }
                    parts.forEachIndexed { i, file ->
                        val expected = min(slice, total - i * slice)
                        // 超长分片不能因“至少够长”被误判完成，也不能进入合并。
                        if (file.length() > expected) file.delete()
                    }
                    val progress = AtomicLong(parts.sumOf { it.length() })
                    task.downloaded = progress.get()
                    val index = java.util.concurrent.atomic.AtomicInteger(0)
                    val fallback = java.util.concurrent.atomic.AtomicBoolean(false)
                    val started = System.nanoTime()
                    val initial = progress.get()
                    coroutineScope {
                        List(min(workerCount, count)) {
                            async(Dispatchers.IO) {
                                while (!fallback.get()) {
                                    val i = index.getAndIncrement()
                                    if (i >= count) break
                                    val start = i * slice
                                    val end = min(total - 1, start + slice - 1)
                                    val result = downloader.downloadChunk(taskId(task.id), url, start, end, parts[i], headers) { bytes ->
                                        throttle(bytes)
                                        task.downloaded = progress.addAndGet(bytes).coerceAtMost(total)
                                        val elapsed = (System.nanoTime() - started) / 1_000_000_000.0
                                        task.speed = if (elapsed >= 0.5) ((progress.get() - initial) / elapsed).toLong() else 0
                                        report(task)
                                    }
                                    if (result != ChunkResult.OK) fallback.set(true)
                                }
                            }
                        }.awaitAll()
                    }
                    if (fallback.get()) {
                        task.downloaded = 0
                        check(downloader.downloadFull(taskId(task.id), url, target, headers, total) { bytes ->
                            throttle(bytes); task.downloaded += bytes; report(task)
                        }) { "分片与单流下载均失败，请重新获取直链" }
                    } else {
                        parts.forEachIndexed { i, part ->
                            check(part.length() == min(slice, total - i * slice)) { "分片不完整，已拒绝合并" }
                        }
                        // Windows 版优先保留恢复能力；合并成功前不删除已有断点。
                        withContext(Dispatchers.IO) {
                            target.outputStream().use { out ->
                                parts.forEach { part ->
                                    part.inputStream().use { input ->
                                        val buffer = ByteArray(65536)
                                        while (true) {
                                            currentCoroutineContext().ensureActive()
                                            val read = input.read(buffer)
                                            if (read < 0) break
                                            out.write(buffer, 0, read)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    check(target.length() == total) { "文件大小校验失败，已拒绝保存" }
                }
            }
            currentCoroutineContext().ensureActive()
            // 不覆盖同目录中后来创建的文件；移动失败时保留断点。
            Files.move(target.toPath(), task.path.toPath())
            dir.deleteRecursively()
        } finally {
            target.delete()
        }
    }

    private suspend fun throttle(bytes: Long) {
        val limit = speedLimit
        if (limit <= 0) return
        val wait = synchronized(rateLock) {
            val now = System.nanoTime()
            val scheduled = maxOf(nextAllowed, now)
            nextAllowed = scheduled + bytes * 1_000_000_000L / limit
            (scheduled - now) / 1_000_000
        }
        if (wait > 0) delay(wait)
    }

    private fun report(task: Task, force: Boolean = false) {
        val now = System.currentTimeMillis()
        val previous = task.lastReport.get()
        if (force || now - previous >= 500) {
            if (force || task.lastReport.compareAndSet(previous, now)) emit("download", task.json())
        }
    }
    private fun partsDirectory(task: Task) = File(task.path.parentFile, ".yunx-parts/${task.id}")
    private fun temporaryDestination(task: Task) = File(task.path.parentFile, ".${task.path.name}.${task.id}.yunx")
    private fun taskId(id: String) = UUID.fromString(id).leastSignificantBits
    companion object {
        fun safeName(value: String): String {
            val name = value.replace(Regex("[\\x00-\\x1f<>:\"/\\\\|?*]"), "_").trim().trimEnd('.', ' ').take(180).ifBlank { "download" }
            return if (Regex("(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)").containsMatchIn(name)) "_$name" else name
        }
        fun requireHttp(value: String) {
            val uri = java.net.URI(value)
            require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null) { "仅支持 HTTP / HTTPS 下载地址" }
        }
        private fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

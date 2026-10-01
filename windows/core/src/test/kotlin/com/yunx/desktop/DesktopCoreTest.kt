package com.yunx.desktop

import com.yunx.app.data.network.ShareLinkParser
import com.yunx.app.data.network.SharePlatform
import com.yunx.app.data.network.GitHubResponseCache
import com.yunx.app.data.network.DesktopProxySelector
import kotlinx.coroutines.*
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.net.Proxy
import java.net.ProxySelector
import java.net.InetSocketAddress
import java.net.SocketAddress
import java.net.URI
import java.io.IOException

class DesktopCoreTest {
    @Test fun systemAndConfiguredProxiesBypassLoopbackOnly() {
        val systemProxy = Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("system.example", 8080))
        val configuredProxy = Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved("manual.example", 8081))
        val system = object : ProxySelector() {
            override fun select(uri: URI) = listOf(systemProxy)
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {}
        }
        for (configured in listOf(null, configuredProxy)) {
            val selector = DesktopProxySelector(system, configured)
            for (host in listOf("localhost", "test.localhost", "127.0.0.1", "127.0.0.2", "[::1]")) {
                assertEquals(listOf(Proxy.NO_PROXY), selector.select(URI("http://$host:4567/file")))
            }
            assertEquals(listOf(configured ?: systemProxy), selector.select(URI("https://github.com/example/repo")))
            assertEquals(listOf(configured ?: systemProxy), selector.select(URI("https://localhost.evil.test/file")))
        }
    }
    @Test fun parsesSupportedLinkAfterAdvertisementAndIgnoresArchivePassword() {
        val parsed = ShareLinkParser.parse("推广 https://example.org/ 解压密码：abcd 链接 https://pan.quark.cn/s/Abc123 提取码：1234")!!
        assertEquals(SharePlatform.QUARK, parsed.platform)
        assertEquals("1234", parsed.pwd)
        assertNull(ShareLinkParser.parse("https://pan.baidu.com/s/1abc?pwd=1234"))
        assertNull(ShareLinkParser.parse("https://evil.test/pan.quark.cn/s/Abc123"))
        assertEquals("Key-123", ShareLinkParser.parse("https://www.123pan.cn/api/srr?sk=Key-123&st=s")!!.shareId)
    }
    @Test fun passwordsDoNotLeakAcrossLinks() {
        val parsed = ShareLinkParser.parse("https://example.org/?pwd=abcd https://drive.uc.cn/s/123ABC 提取码：5678")!!
        assertEquals("5678", parsed.pwd)
    }
    @Test fun filenamesRespectWindowsReservedNamesAndDirectoryBoundaries() {
        assertEquals("_CON.txt", DownloadEngine.safeName("CON.txt"))
        assertFalse(DownloadEngine.safeName("../../secret?.txt").contains('/'))
        assertFalse(DownloadEngine.safeName("test. ").endsWith('.'))
        assertThrows(IllegalArgumentException::class.java) { DownloadEngine.requireHttp("file:///C:/test") }
    }
    @Test fun cancelledCacheOwnerDoesNotLeavePermanentWaiter() = runBlocking {
        val key = "test-${System.nanoTime()}"
        val started = CompletableDeferred<Unit>()
        val first = launch { GitHubResponseCache.getOrFetch(key) { started.complete(Unit); delay(10_000); "first" } }
        started.await(); first.cancelAndJoin()
        assertEquals("second", withTimeout(2000) { GitHubResponseCache.getOrFetch(key) { "second" } })
    }
    @Test fun rangeAndIgnoredRangeBothProduceExactFile() = runBlocking {
        for (ignoresRange in listOf(false, true)) {
            val server = MockWebServer()
            val data = ByteArray(256 * 1024) { (it % 251).toByte() }
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val header = request.getHeader("Range")
                    if (!ignoresRange && header != null) {
                        val parts = header.removePrefix("bytes=").split('-')
                        val from = parts[0].toInt(); val to = parts[1].toInt()
                        return MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes $from-$to/${data.size}")
                            .setBody(Buffer().write(data, from, to - from + 1))
                    }
                    return MockResponse().setBody(Buffer().write(data))
                }
            }
            server.start()
            val directory = Files.createTempDirectory("yunx-range").toFile()
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
            val events = ConcurrentHashMap<String, JSONObject>()
            val engine = DownloadEngine(scope, { type, value -> if (type == "download") events[value.getString("id")] = value }, {})
            try {
                val task = engine.enqueue(JSONObject().put("url", server.url("/file").toString()).put("fileName", "sample.bin"), directory.absolutePath)
                val id = task.getString("id")
                withTimeout(10000) { while (events[id]?.optString("status") !in listOf("completed", "failed")) delay(30) }
                assertEquals("completed", events[id]!!.getString("status"))
                assertArrayEquals(data, java.io.File(events[id]!!.getString("path")).readBytes())
            } finally { engine.shutdown(); scope.cancel(); server.shutdown(); directory.deleteRecursively() }
        }
    }
    @Test fun pauseResumeRetainsRealBytesAndRestoresAsPaused() = runBlocking {
        val data = ByteArray(2 * 1024 * 1024) { (it % 239).toByte() }
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val range = request.getHeader("Range")!!.removePrefix("bytes=").split('-')
                val from = range[0].toInt(); val to = range[1].toInt()
                return MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes $from-$to/${data.size}")
                    .setBody(Buffer().write(data, from, to - from + 1)).throttleBody(8192, 8, TimeUnit.MILLISECONDS)
            }
        }
        server.start()
        val directory = Files.createTempDirectory("yunx-resume").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val events = ConcurrentHashMap<String, JSONObject>()
        val engine = DownloadEngine(scope, { type, value -> if (type == "download") events[value.getString("id")] = value }, {})
        try {
            val initial = engine.enqueue(JSONObject().put("url", server.url("/file").toString()).put("fileName", "resume.bin"), directory.absolutePath)
            val id = initial.getString("id")
            withTimeout(5000) { while ((events[id]?.optLong("downloaded") ?: 0) < 100000) delay(20) }
            engine.pause(id)
            assertEquals("paused", events[id]!!.getString("status"))
            val restored = DownloadEngine(scope, { _, _ -> }, {})
            restored.restore(listOf(JSONObject(events[id]!!.toString()).put("status", "downloading")))
            assertEquals("paused", restored.list().first().getString("status"))
            engine.start(id)
            withTimeout(15000) { while (events[id]?.optString("status") !in listOf("completed", "failed")) delay(25) }
            assertEquals("completed", events[id]!!.getString("status"))
            assertArrayEquals(data, java.io.File(events[id]!!.getString("path")).readBytes())
        } finally { engine.shutdown(); scope.cancel(); server.shutdown(); directory.deleteRecursively() }
    }
}

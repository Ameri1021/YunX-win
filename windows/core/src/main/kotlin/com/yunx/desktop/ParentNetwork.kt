package com.yunx.desktop

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okio.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InterruptedIOException
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicLong

/** 连接由主进程的 Chromium 完成；下载仍按核心原有区间和长度规则写盘。 */
class ParentNetwork(private val emit: (String, JSONObject) -> Unit) : Interceptor {
    private class Exchange {
        val headers = CompletableFuture<JSONObject>()
        val parts = LinkedBlockingQueue<JSONObject>(2)
    }
    private val sequence = AtomicLong()
    private val active = ConcurrentHashMap<String, Exchange>()

    fun accept(method: String, data: JSONObject) {
        val id = data.optString("id")
        val exchange = active[id] ?: return
        when (method) {
            "network.response" -> exchange.headers.complete(data)
            "network.chunk", "network.end", "network.error" -> {
                if (method == "network.error") exchange.headers.completeExceptionally(IOException("网络连接失败"))
                if (!exchange.parts.offer(JSONObject(data.toString()).put("type", method))) cancel(id)
            }
        }
    }

    private fun cancel(id: String) {
        active.remove(id)?.let { exchange ->
            exchange.headers.completeExceptionally(InterruptedIOException("请求已取消"))
            exchange.parts.clear()
            exchange.parts.offer(JSONObject().put("type", "network.error"))
            emit("networkCancel", JSONObject().put("id", id))
        }
    }
    fun close() { active.keys.toList().forEach(::cancel) }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        DownloadEngine.requireHttp(request.url.toString())
        val id = sequence.incrementAndGet().toString()
        val exchange = Exchange()
        val body = Buffer()
        request.body?.writeTo(body)
        require(body.size <= 2 * 1024 * 1024) { "请求数据过大" }
        val headers = JSONArray()
        request.headers.forEach { (name, value) -> headers.put(JSONArray().put(name).put(value)) }
        active[id] = exchange
        emit("networkRequest", JSONObject().put("id", id).put("url", request.url.toString()).put("method", request.method)
            .put("headers", headers).put("body", Base64.getEncoder().encodeToString(body.readByteArray())))
        try {
            val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(chain.connectTimeoutMillis().toLong().coerceAtLeast(15000))
            var metadata: JSONObject? = null
            while (metadata == null) {
                if (chain.call().isCanceled()) throw InterruptedIOException("请求已取消")
                if (System.nanoTime() > deadline) throw InterruptedIOException("网络连接超时")
                try { metadata = exchange.headers.get(100, TimeUnit.MILLISECONDS) } catch (_: TimeoutException) {}
            }
            val responseHeaders = Headers.Builder()
            val pairs = metadata.getJSONArray("headers")
            for (index in 0 until pairs.length()) {
                val pair = pairs.getJSONArray(index)
                responseHeaders.add(pair.getString(0), pair.getString(1))
            }
            val parsedHeaders = responseHeaders.build()
            val responseBody = object : ResponseBody() {
                private val source = object : Source {
                    private val buffer = Buffer()
                    private var ended = false
                    private var closed = false
                    override fun timeout() = Timeout.NONE
                    override fun read(sink: Buffer, byteCount: Long): Long {
                        require(byteCount >= 0)
                        check(!closed) { "数据流已关闭" }
                        if (byteCount == 0L) return 0
                        val timeoutAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(chain.readTimeoutMillis().toLong().coerceAtLeast(1000))
                        while (buffer.size == 0L && !ended) {
                            if (chain.call().isCanceled()) { close(); throw InterruptedIOException("请求已取消") }
                            if (System.nanoTime() > timeoutAt) { close(); throw InterruptedIOException("网络读取超时") }
                            val part = exchange.parts.poll(100, TimeUnit.MILLISECONDS) ?: continue
                            when (part.getString("type")) {
                                "network.chunk" -> {
                                    val bytes = Base64.getDecoder().decode(part.getString("body"))
                                    require(bytes.size <= 65536) { "数据块过大" }
                                    buffer.write(bytes)
                                    emit("networkAck", JSONObject().put("id", id))
                                }
                                "network.end" -> { ended = true; active.remove(id) }
                                else -> { close(); throw IOException("网络连接失败") }
                            }
                        }
                        return if (buffer.size == 0L) -1 else buffer.read(sink, byteCount)
                    }
                    override fun close() { if (!closed) { closed = true; buffer.clear(); cancel(id) } }
                }.buffer()
                override fun contentType() = parsedHeaders["Content-Type"]?.toMediaTypeOrNull()
                override fun contentLength() = if (request.method == "HEAD" || metadata.getInt("status") in listOf(204, 304)) 0L else parsedHeaders["Content-Length"]?.toLongOrNull() ?: -1L
                override fun source() = source
            }
            return Response.Builder().request(request.newBuilder().url(metadata.getString("url")).build()).protocol(Protocol.HTTP_1_1)
                .code(metadata.getInt("status")).message("").headers(parsedHeaders).body(responseBody).build()
        } catch (error: Exception) {
            cancel(id)
            if (error is IOException) throw error
            throw IOException("网络连接失败", error)
        }
    }
}

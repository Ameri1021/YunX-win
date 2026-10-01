package com.yunx.desktop

import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ParentNetworkTest {
    @Test fun streamsRangeResponseWithExactBytesAndPreservesStatus() {
        val bytes = ByteArray(100000) { (it % 251).toByte() }
        val chunks = listOf(bytes.copyOfRange(0, 65536), bytes.copyOfRange(65536, bytes.size))
        var next = 0
        lateinit var network: ParentNetwork
        network = ParentNetwork { type, data ->
            val id = data.getString("id")
            when (type) {
                "networkRequest" -> {
                    network.accept("network.response", JSONObject().put("id", id).put("status", 206).put("url", data.getString("url"))
                        .put("headers", JSONArray().put(JSONArray().put("Content-Length").put(bytes.size.toString())).put(JSONArray().put("Content-Range").put("bytes 0-99999/100000"))))
                    network.accept("network.chunk", JSONObject().put("id", id).put("body", Base64.getEncoder().encodeToString(chunks[next++])))
                }
                "networkAck" -> if (next < chunks.size) network.accept("network.chunk", JSONObject().put("id", id).put("body", Base64.getEncoder().encodeToString(chunks[next++])))
                    else network.accept("network.end", JSONObject().put("id", id))
            }
        }
        val client = OkHttpClient.Builder().addInterceptor(network).build()
        client.newCall(Request.Builder().url("https://example.test/file").header("Range", "bytes=0-99999").build()).execute().use {
            assertEquals(206, it.code)
            assertEquals("bytes 0-99999/100000", it.header("Content-Range"))
            assertArrayEquals(bytes, it.body!!.bytes())
        }
        network.close()
    }

    @Test fun cancellationInterruptsWaitingBodyAndNotifiesParent() {
        val cancelled = AtomicBoolean()
        lateinit var network: ParentNetwork
        network = ParentNetwork { type, data ->
            if (type == "networkRequest") network.accept("network.response", JSONObject().put("id", data.getString("id")).put("status", 200)
                .put("url", data.getString("url")).put("headers", JSONArray()))
            if (type == "networkCancel") cancelled.set(true)
        }
        val call = OkHttpClient.Builder().addInterceptor(network).build().newCall(Request.Builder().url("https://example.test/file").build())
        val response = call.execute()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<Boolean> { try { response.body!!.bytes(); false } catch (_: java.io.IOException) { true } }
            call.cancel()
            assertTrue(result.get(2, TimeUnit.SECONDS)); assertTrue(cancelled.get())
        } finally { response.close(); executor.shutdownNow(); network.close() }
    }
}

package com.yunx.desktop

import com.yunx.app.data.network.HttpClients
import com.yunx.app.data.network.XunleiDeviceFingerprint
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.PrintWriter

/** 使用父进程专有的标准输入输出通信，不监听端口，不对网页开放本地服务。 */
fun main(args: Array<String>): Unit = runBlocking {
    val writer = PrintWriter(System.out, true, Charsets.UTF_8)
    fun send(value: JSONObject) { synchronized(writer) { writer.println(value.toString()) } }
    fun emit(type: String, data: JSONObject) { send(JSONObject().put("event", type).put("data", data)) }
    val network = ParentNetwork(::emit)
    HttpClients.setTransport(network)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    XunleiDeviceFingerprint.init(File(args.firstOrNull() ?: "."))
    val service = PlatformService(::emit)
    val downloads = DownloadEngine(scope, ::emit, service::cleanup)
    emit("ready", JSONObject().put("version", "1.0.0").put("platforms", JSONArray(PlatformService.PLATFORMS)))
    try {
        val reader = System.`in`.bufferedReader(Charsets.UTF_8)
        while (true) {
            val line = reader.readLine() ?: break
            val message = try { JSONObject(line) } catch (_: Exception) { continue }
            if (message.optString("method").startsWith("network.")) {
                network.accept(message.getString("method"), message.optJSONObject("params") ?: JSONObject())
                continue
            }
            scope.launch {
                val id = message.optString("id")
                try {
                    val params = message.optJSONObject("params") ?: JSONObject()
                    val result: Any = when (message.optString("method")) {
                        "ping" -> JSONObject().put("ok", true)
                        "configure" -> {
                            downloads.threads = params.optInt("threads", 8).coerceIn(1, 32)
                            downloads.concurrency = params.optInt("concurrency", 3).coerceIn(1, 5)
                            downloads.speedLimit = params.optLong("speedLimit", 0).coerceAtLeast(0)
                            HttpClients.setProxy(params.optString("proxyHost").ifBlank { null }, params.optInt("proxyPort", 0))
                            JSONObject().put("ok", true)
                        }
                        "credentials.set" -> { service.setCredentials(params); JSONObject().put("ok", true) }
                        "credentials.validate" -> service.validate(params.getString("platform"), params.getJSONObject("record"))
                        "share.resolve" -> service.resolve(params.getString("text"), params.optString("password"))
                        "share.list" -> service.list(params.getString("sessionId"), params.optString("directory", "0"))
                        "cloud.list" -> service.cloud(params.getString("platform"))
                        "download.link" -> service.downloadLink(params.getString("ref"))
                        "download.folder" -> service.folderDownloads(params.getString("ref"))
                        "xunlei.sms" -> service.xunleiLogin("sms", params)
                        "xunlei.password" -> service.xunleiLogin("password", params)
                        "xunlei.code" -> service.xunleiLogin("code", params)
                        "download.enqueue" -> downloads.enqueue(params.getJSONObject("spec"), params.getString("directory"))
                        "download.restore" -> {
                            val values = params.optJSONArray("tasks") ?: JSONArray()
                            downloads.restore((0 until values.length()).map { values.getJSONObject(it) })
                            JSONArray(downloads.list())
                        }
                        "download.list" -> JSONArray(downloads.list())
                        "download.pause" -> { downloads.pause(params.getString("id")); JSONObject().put("ok", true) }
                        "download.resume" -> { downloads.start(params.getString("id")); JSONObject().put("ok", true) }
                        "download.remove" -> { downloads.remove(params.getString("id")); JSONObject().put("ok", true) }
                        "shutdown" -> { downloads.shutdown(); JSONObject().put("ok", true) }
                        else -> error("未知的应用操作")
                    }
                    send(JSONObject().put("id", id).put("result", result))
                } catch (ce: CancellationException) {
                    send(JSONObject().put("id", id).put("error", "操作已取消"))
                    throw ce
                } catch (error: Exception) {
                    val message = if (error is java.io.IOException) "网络请求失败，请检查系统网络设置，或在设置中配置 HTTP 代理" else error.message ?: "操作失败，请检查网络与登录状态"
                    val safeMessage = com.yunx.app.util.LogRedactor.line(message).take(500)
                    send(JSONObject().put("id", id).put("error", safeMessage))
                }
            }
        }
    } finally {
        downloads.shutdown()
        network.close()
        scope.cancel()
    }
    kotlin.system.exitProcess(0)
}

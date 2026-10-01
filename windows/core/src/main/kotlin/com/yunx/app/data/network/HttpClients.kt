/*
 * YunX (云析) - A network drive share-link parser and high-speed downloader for Android.
 * Copyright (C) 2026 CYQawa
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

package com.yunx.app.data.network

import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Interceptor
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Windows 系统代理未必包含本地例外；回环请求始终直连，其余遵循应用或系统代理。 */
internal class DesktopProxySelector(private val system: ProxySelector?, private val configured: Proxy? = null) : ProxySelector() {
    override fun select(uri: URI): List<Proxy> {
        val host = uri.host.orEmpty().removePrefix("[").removeSuffix("]").lowercase()
        val loopback = host == "localhost" || host.endsWith(".localhost") || host == "::1" ||
            host == "0:0:0:0:0:0:0:1" || Regex("127(?:\\.\\d{1,3}){3}").matches(host)
        if (loopback) return listOf(Proxy.NO_PROXY)
        return configured?.let { listOf(it) } ?: system?.select(uri)?.takeIf { it.isNotEmpty() } ?: listOf(Proxy.NO_PROXY)
    }
    override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {
        if (configured == null) system?.connectFailed(uri, address, error)
    }
}

/**
 * 全局 HTTP 客户端管理：
 * - [apiClient]：平台 API（登录/解析/直链）、HLS 下载、更新检查共用，超时宽松；
 * - [downloadClient]：分片下载专用，大 Dispatcher 保障分片并发（默认实例 maxRequestsPerHost=5 会锁死并发）。
 * 所有构建都使用系统证书链和 OkHttp 主机名校验，不提供进程内绕过开关。
 */
object HttpClients {

    @Volatile private var transport: Interceptor? = null
    fun setTransport(value: Interceptor?) {
        synchronized(lock) { transport = value; apiCache = null; downloadCache = null }
    }

    private val lock = Any()

    @Volatile
    private var apiCache: OkHttpClient? = null

    @Volatile
    private var downloadCache: OkHttpClient? = null

    /** 当前生效的 HTTP 代理主机；null 表示使用系统设置 */
    @Volatile
    private var proxyHost: String? = null

    /** 当前生效的 HTTP 代理端口；0 表示使用系统设置 */
    @Volatile
    private var proxyPort: Int = 0

    /**
     * 配置全局 HTTP 代理。host 为 null 或 port 不在 1-65535 时使用系统设置。
     * 调用后清空已构建的客户端缓存，使下次获取时按新代理重建，立即生效。
     * 本对象不持有 Context，仅依赖 java.net 标准库与 OkHttp 内置代理支持。
     */
    fun setProxy(host: String?, port: Int) {
        synchronized(lock) {
            proxyHost = host
            proxyPort = port
            // 使既有客户端失效：下次 apiClient()/downloadClient() 时重建，代理立即生效
            apiCache = null
            downloadCache = null
        }
    }

    /** 仅在应用代理配置有效时构建固定代理，其余委托系统。 */
    private fun currentProxy(): Proxy? {
        val host = proxyHost ?: return null
        if (proxyPort !in 1..65535) return null
        return Proxy(Proxy.Type.HTTP, InetSocketAddress(host, proxyPort))
    }

    /** 普通 API 客户端（各平台 API、HLS、更新检查） */
    fun apiClient(): OkHttpClient {
        apiCache?.let { return it }
        synchronized(lock) {
            apiCache?.let { return it }
            return buildApi().also { apiCache = it }
        }
    }

    /** 下载专用客户端：大 Dispatcher + 长超时，不锁死分片并发 */
    fun downloadClient(): OkHttpClient {
        downloadCache?.let { return it }
        synchronized(lock) {
            downloadCache?.let { return it }
            return buildDownload().also { downloadCache = it }
        }
    }

    private fun buildApi(): OkHttpClient {
        return OkHttpClient.Builder()
            .apply { transport?.let { addInterceptor(it) } }
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .proxySelector(DesktopProxySelector(ProxySelector.getDefault(), currentProxy()))
            .build()
    }

    private fun buildDownload(): OkHttpClient {
        val dispatcher = Dispatcher().apply {
            maxRequests = 64
            maxRequestsPerHost = 32 // 与 Windows 设置页线程数上限对齐
        }
        return OkHttpClient.Builder()
            .apply { transport?.let { addInterceptor(it) } }
            .dispatcher(dispatcher)
            // 自动重定向跨源时剥离手工凭证，签名直链仍可正常重定向。
            .addNetworkInterceptor { chain ->
                val request = chain.request()
                val initial = chain.call().request().url
                val redirected = initial.scheme != request.url.scheme || initial.host != request.url.host || initial.port != request.url.port
                chain.proceed(if (redirected) request.newBuilder().removeHeader("Cookie").removeHeader("Authorization").build() else request)
            }
            .connectionPool(
                ConnectionPool(
                    maxIdleConnections = 64,
                    keepAliveDuration = 5,
                    timeUnit = TimeUnit.MINUTES
                )
            )
            .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .proxySelector(DesktopProxySelector(ProxySelector.getDefault(), currentProxy()))
            .build()
    }
}

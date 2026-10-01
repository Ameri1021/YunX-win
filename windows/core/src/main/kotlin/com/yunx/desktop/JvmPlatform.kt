package com.yunx.desktop

import com.yunx.app.util.LogRedactor
import java.util.Base64

/** 协议层使用标准 JVM 编解码，保留原有平台参数的语义。 */
object JvmBase64 {
    const val DEFAULT = 0
    const val NO_PADDING = 1
    const val NO_WRAP = 2
    const val URL_SAFE = 8
    fun decode(value: String, flags: Int): ByteArray =
        (if (flags and URL_SAFE != 0) Base64.getUrlDecoder() else Base64.getMimeDecoder()).decode(value)
    fun decode(value: ByteArray, flags: Int): ByteArray = decode(value.toString(Charsets.UTF_8), flags)
    fun encodeToString(value: ByteArray, flags: Int): String {
        var encoder = if (flags and URL_SAFE != 0) Base64.getUrlEncoder() else Base64.getEncoder()
        if (flags and NO_PADDING != 0) encoder = encoder.withoutPadding()
        return encoder.encodeToString(value)
    }
}

/** 标准输出专用于通信，日志写标准错误且不回显服务器异常与凭证。 */
object JvmLog {
    fun d(tag: String, message: String): Int = 0
    fun i(tag: String, message: String): Int = 0
    fun w(tag: String, message: String): Int = log(tag, message)
    fun e(tag: String, message: String): Int = log(tag, message)
    fun e(tag: String, message: String, error: Throwable): Int = log(tag, error.javaClass.simpleName)
    private fun log(tag: String, message: String): Int {
        System.err.println("[$tag] ${LogRedactor.line(message)}")
        return 0
    }
}

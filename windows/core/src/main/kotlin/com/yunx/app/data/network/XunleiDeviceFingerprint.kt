package com.yunx.app.data.network

import java.io.File
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID

/** 每次安装独立保存设备标识，避免所有桌面用户共用同一个指纹。 */
object XunleiDeviceFingerprint {
    private var id = UUID.randomUUID().toString().replace("-", "")
    private var peer = UUID.randomUUID().toString().replace("-", "")
    @Synchronized fun init(directory: File) {
        directory.mkdirs()
        val file = File(directory, "device.properties")
        val props = Properties()
        if (file.exists()) file.inputStream().use { props.load(it) }
        id = props.getProperty("id", id)
        peer = props.getProperty("peer", peer)
        props.setProperty("id", id)
        props.setProperty("peer", peer)
        file.outputStream().use { props.store(it, "YunX device") }
    }
    fun deviceId() = id
    fun peerId() = peer
    fun deviceSign(): String {
        fun hash(type: String, value: String) = MessageDigest.getInstance(type)
            .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
        return "div101.$id${hash("MD5", hash("SHA-1", id + "com.xunlei.downloadprovider" + "40" + "34a062aaa22f906fca4fefe9fb3a3021"))}"
    }
}

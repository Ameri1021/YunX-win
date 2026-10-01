package com.yunx.app.data.network

import java.net.URI

enum class SharePlatform { QUARK, UC, XUNLEI, C139, PAN123, GITHUB }
data class ParsedShare(val shareId: String, val pwd: String?, val platform: SharePlatform)

/** 遍历整段文案中的地址，只在命中的地址附近关联提取码。 */
object ShareLinkParser {
    private val urls = Regex("https?://[^\\s<>]+", RegexOption.IGNORE_CASE)
    private val explicitPwd = Regex("(?:提取码|访问码)[：:]?\\s*([A-Za-z0-9]{4,8})(?![A-Za-z0-9])")
    fun parse(text: String): ParsedShare? {
        val matches = urls.findAll(text).toList()
        for ((index, match) in matches.withIndex()) {
            val url = match.value.trimEnd('。', '，', ',', '；', ';', ')', ']', '}', '）', '】', '」', '"', '\'')
            val uri = runCatching { URI(url) }.getOrNull() ?: continue
            val host = uri.host?.lowercase() ?: continue
            val path = uri.path.orEmpty()
            val platform = when (host) {
                "pan.quark.cn" -> SharePlatform.QUARK
                "drive.uc.cn" -> SharePlatform.UC
                "pan.xunlei.com" -> SharePlatform.XUNLEI
                "yun.139.com" -> SharePlatform.C139
                "123pan.com", "www.123pan.com", "123pan.cn", "www.123pan.cn", "123865.com", "www.123865.com" -> SharePlatform.PAN123
                else -> if (host.endsWith(".share.123pan.cn")) SharePlatform.PAN123 else continue
            }
            val id = when (platform) {
                SharePlatform.C139 -> Regex("/w/i/([A-Za-z0-9_-]+)").find(path + "#" + uri.fragment.orEmpty())?.groupValues?.get(1)
                SharePlatform.PAN123 -> Regex("/(?:s|123pan)/([A-Za-z0-9-]+)").find(path)?.groupValues?.get(1)
                    ?: Regex("(?:^|&)sk=([A-Za-z0-9-]+)").find(uri.query.orEmpty())?.groupValues?.get(1)
                else -> Regex("/s/([A-Za-z0-9_-]+)").find(path)?.groupValues?.get(1)
            } ?: continue
            val end = matches.getOrNull(index + 1)?.range?.first ?: text.length
            val near = text.substring(match.range.last + 1, end)
            val queryPwd = Regex("(?:^|&)pwd=([A-Za-z0-9]{4,8})(?:&|$)").find(uri.query.orEmpty())?.groupValues?.get(1)
            val pwd = queryPwd ?: explicitPwd.find(near)?.groupValues?.get(1)
                ?: if (matches.size == 1) explicitPwd.find(text)?.groupValues?.get(1) else null
            return ParsedShare(id, pwd, platform)
        }
        return null
    }
}

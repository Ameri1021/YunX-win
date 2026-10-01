package com.yunx.desktop

import com.yunx.app.data.network.*
import com.yunx.app.data.network.model.*
import com.yunx.app.data.repository.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** 凭证只从桌面主进程注入；本服务不将账号信息写入磁盘。 */
class PlatformService(private val emit: (String, JSONObject) -> Unit) {
    val credentials = ConcurrentHashMap<String, JSONObject>()
    private val quarkApi = QuarkApi()
    private val ucApi = UCApi()
    private val xunleiApi = XunleiApi()
    private val c139Api = C139Api()
    private val panApi = Pan123Api()
    private val quark = QuarkResolveRepository(quarkApi)
    private val uc = UCResolveRepository(ucApi)
    private val c139 = C139ResolveRepository(c139Api)
    private val pan = Pan123ResolveRepository(panApi) { credential("pan123").optString("token").ifBlank { null } }
    private val xunlei = XunleiResolveRepository(
        xunleiApi,
        { credential("xunlei").optString("accessToken").ifBlank { null } },
        { credential("xunlei").optString("deviceId", XunleiDeviceFingerprint.deviceId()) },
        { credential("xunlei").optString("captchaToken") },
        {
            val value = credential("xunlei")
            val result = value.optString("refreshToken").takeIf { it.isNotBlank() }?.let {
                xunleiApi.refreshToken(it, value.optString("deviceId", XunleiDeviceFingerprint.deviceId()))
            }
            result?.also {
                value.put("accessToken", it.first).put("refreshToken", it.second)
                updateCredential("xunlei", value)
            }
        }
    )
    private data class Context(
        val platform: String, val session: ShareSession? = null, val cloud: Boolean = false,
        val owner: String = "", val repository: String = "", val ref: String = "", val title: String = "", val privateRepo: Boolean = false
    )
    private data class Entry(val context: Context, val file: ShareFile? = null, val url: String = "", val ref: String = "")
    private val contexts = ConcurrentHashMap<String, Context>()
    private val entries = ConcurrentHashMap<String, Entry>()

    init {
        quarkApi.cookieSink = { value ->
            val stored = credentials["quark"]
            if (stored != null && value != stored.optString("cookie")) {
                updateCredential("quark", JSONObject(stored.toString()).put("cookie", value))
            }
        }
        ucApi.cookieSink = { value ->
            val stored = credentials["uc"]
            if (stored != null && value != stored.optString("cookie")) {
                updateCredential("uc", JSONObject(stored.toString()).put("cookie", value))
            }
        }
    }

    private fun credential(platform: String) = credentials[platform] ?: JSONObject()
    private fun value(platform: String): String = when (platform) {
        "pan123", "github" -> credential(platform).optString("token")
        "xunlei" -> credential(platform).optString("accessToken")
        else -> credential(platform).optString("cookie")
    }
    private fun repo(platform: String): ShareResolveRepository = when (platform) {
        "quark" -> quark; "uc" -> uc; "xunlei" -> xunlei; "c139" -> c139; "pan123" -> pan
        else -> error("不支持的平台")
    }
    fun setCredentials(all: JSONObject) {
        credentials.clear()
        all.keySet().filter { it in PLATFORMS }.forEach { platform -> all.optJSONObject(platform)?.let { credentials[platform] = it } }
    }
    private fun updateCredential(platform: String, record: JSONObject) {
        credentials[platform] = record
        emit("credential", JSONObject().put("platform", platform).put("record", record))
    }

    suspend fun validate(platform: String, record: JSONObject): JSONObject {
        require(platform in PLATFORMS) { "不支持的平台" }
        val name = when (platform) {
            "quark" -> quarkApi.fetchNickname(record.optString("cookie"))
            "uc" -> ucApi.fetchNickname(record.optString("cookie"))
            "pan123" -> panApi.fetchNickname(record.optString("token"))
            "c139" -> {
                require(C139Constants.isValidCookie(record.optString("cookie"))) { "139 登录信息不完整，请完成网页登录后重试" }
                require(!C139Constants.extractAccountFull(record.optString("cookie")).isNullOrBlank()) { "139 登录态缺少账号信息" }
                c139Api.getQuota(record.optString("cookie")) ?: error("139 凭证校验失败，请重新登录")
                C139Constants.extractAccount(record.optString("cookie"))
            }
            "xunlei" -> {
                require(record.optString("accessToken").isNotBlank()) { "缺少迅雷 access_token" }
                val quota = xunleiApi.getQuota(record.optString("accessToken"), record.optString("deviceId", XunleiDeviceFingerprint.deviceId()), record.optString("captchaToken"))
                if (quota == null) error("迅雷登录信息无效或已过期")
                record.optString("nickname", "迅雷用户")
            }
            "github" -> {
                require(record.optString("token").isNotBlank()) { "请输入 GitHub Token" }
                githubJson("https://api.github.com/user", record.optString("token")).getString("login")
            }
            else -> null
        } ?: error("登录信息无效或已过期，请在官方网站完成登录")
        return JSONObject(record.toString()).put("nickname", name)
    }

    suspend fun resolve(text: String, password: String): JSONObject {
        val parsed = ShareLinkParser.parse(text)
        if (parsed == null) {
            val github = GitHubLinkParser.parse(text) ?: error("无法识别链接，请粘贴支持的平台分享链接或 GitHub 地址")
            return resolveGitHub(github)
        }
        val platform = parsed.platform.name.lowercase()
        require(value(platform).isNotBlank() || platform == "pan123") { "请先在账号页登录${NAMES[platform]}" }
        val session = repo(platform).createSession(text, password.ifBlank { parsed.pwd }, value(platform)).getOrThrow()
        val context = Context(platform, session, title = session.title)
        val id = register(context)
        return list(id, "0")
    }

    suspend fun cloud(platform: String): JSONObject {
        require(platform in PLATFORMS) { "不支持的平台" }
        require(value(platform).isNotBlank()) { "请先登录${NAMES[platform]}" }
        if (platform == "github") {
            val login = githubJson("https://api.github.com/user").getString("login")
            return githubAccount(login, authenticated = true)
        }
        val id = register(Context(platform, cloud = true, title = "${NAMES[platform]} · 我的文件"))
        return list(id, "0")
    }

    suspend fun list(id: String, directory: String): JSONObject {
        val context = contexts[id] ?: error("浏览会话已过期，请重新解析")
        if (context.platform == "github") return githubList(id, context, directory)
        val credential = value(context.platform)
        val files = if (context.cloud) when (context.platform) {
            "quark" -> quarkApi.listCloudFiles(directory, credential)
            "uc" -> ucApi.listCloudFiles(directory, credential)
            "c139" -> c139Api.listCloudFiles(directory.ifBlank { "root" }.let { if (it == "0") "root" else it }, credential)
            "pan123" -> panApi.listCloudFiles(directory, credential)
            "xunlei" -> xunleiApi.getFiles(if (directory == "0") "" else directory, credential,
                credential("xunlei").optString("deviceId", XunleiDeviceFingerprint.deviceId()), credential("xunlei").optString("captchaToken")) ?: error("读取迅雷文件列表失败，请检查登录状态")
            else -> emptyList()
        } else repo(context.platform).listFiles(context.session!!, directory, credential).getOrThrow()
        val items = JSONArray()
        (files ?: error("读取文件列表失败，请检查登录状态")).sortedWith(compareByDescending<ShareFile> { it.isdir }.thenBy { it.fname.lowercase() }).forEach { file ->
            val ref = UUID.randomUUID().toString()
            entries[ref] = Entry(context, file)
            items.put(JSONObject().put("ref", ref).put("id", file.fid).put("name", file.fname)
                .put("size", file.fsize).put("isDir", file.isdir).put("modified", file.modifyTime))
        }
        return result(id, context, directory, items)
    }

    suspend fun downloadLink(ref: String): JSONObject {
        val entry = entries[ref] ?: error("文件信息已过期，请刷新列表")
        val context = entry.context
        if (context.platform == "github") {
            val headers = JSONObject()
            if (java.net.URI(entry.url).host == "api.github.com" && value("github").isNotBlank()) {
                headers.put("Authorization", "Bearer ${value("github")}").put("Accept", "application/octet-stream")
                    .put("User-Agent", "YunX-Windows")
            }
            return JSONObject().put("url", entry.url).put("fileName", entry.file!!.fname)
                .put("size", entry.file.fsize).put("platform", "github").put("headers", headers)
        }
        val file = entry.file ?: error("文件不存在")
        require(!file.isdir) { "请进入文件夹后选择文件下载" }
        val credential = value(context.platform)
        val link = if (context.cloud) when (context.platform) {
            "quark" -> quarkApi.getDownloadLink(file.fid, credential)
            "uc" -> ucApi.cloudGetDownloadLink(file.fid, credential)
            "c139" -> c139Api.getDownloadUrl(file.fid, credential)
            "pan123" -> panApi.getDownloadLink(file, credential)
            "xunlei" -> xunleiApi.getFileDetail(file.fid, credential, credential("xunlei").optString("deviceId", XunleiDeviceFingerprint.deviceId()), credential("xunlei").optString("captchaToken"))
            else -> null
        } else repo(context.platform).getShareDownloadLink(context.session!!, file, credential).getOrThrow()
        requireNotNull(link) { "获取下载直链失败，登录可能已过期" }
        val headers = when (context.platform) {
            "quark" -> mapOf("Cookie" to value("quark"), "User-Agent" to QuarkConstants.API_USER_AGENT, "Referer" to QuarkConstants.DOWNLOAD_REFERER)
            "uc" -> mapOf("Cookie" to value("uc"), "User-Agent" to UCConstants.USER_AGENT, "Referer" to UCConstants.DOWNLOAD_REFERER, "Origin" to UCConstants.WEB_ORIGIN)
            "xunlei" -> mapOf("User-Agent" to XunleiConstants.APP_UA)
            "c139" -> mapOf("User-Agent" to C139Constants.PC_UA)
            else -> mapOf("User-Agent" to Pan123Constants.WEB_UA, "Referer" to Pan123Constants.DOWNLOAD_REFERER)
        }
        return JSONObject().put("url", link.downloadUrl).put("fileName", file.fname.ifBlank { link.filename })
            .put("size", link.size).put("platform", context.platform).put("headers", JSONObject(headers))
            .put("isHls", link.isHls).put("cleanupDirFid", link.cleanupDirFid ?: "")
    }

    suspend fun cleanup(spec: JSONObject) {
        val dir = spec.optString("cleanupDirFid")
        if (dir.isNotBlank() && spec.optString("platform") == "quark" && value("quark").isNotBlank()) {
            quark.cleanupTempDir(dir, value("quark"))
        }
    }

    /** 文件夹递归使用同一浏览上下文，保留相对目录并限制深度与数量。 */
    suspend fun folderDownloads(ref: String): JSONArray {
        val entry = entries[ref] ?: error("文件夹信息已过期")
        val file = entry.file ?: error("文件夹不存在")
        require(file.isdir) { "请选择文件夹" }
        val id = register(entry.context)
        val output = JSONArray()
        val visited = mutableSetOf<String>()
        suspend fun walk(directory: String, parent: String, depth: Int) {
            require(depth <= 32 && output.length() < 5000) { "文件夹过深或文件过多，请拆分下载" }
            require(visited.add(directory)) { "目录循环，已停止下载" }
            val items = list(id, directory).getJSONArray("items")
            for (index in 0 until items.length()) {
                val item = items.getJSONObject(index)
                if (item.optBoolean("isDir")) walk(item.getString("id"), parent + "/" + DownloadEngine.safeName(item.getString("name")), depth + 1)
                else {
                    require(output.length() < 5000) { "文件过多，请拆分下载" }
                    output.put(downloadLink(item.getString("ref")).put("relativeParent", parent))
                }
            }
        }
        walk(file.fid, DownloadEngine.safeName(file.fname), 0)
        return output
    }

    suspend fun xunleiLogin(mode: String, params: JSONObject): JSONObject {
        val account = params.optString("account").trim()
        require(account.isNotBlank()) { "请输入账号或手机号" }
        val device = XunleiDeviceFingerprint.deviceId()
        if (mode == "sms") {
            val step = xunleiApi.sendSms(account, device)
            require(step.smsCreditKey.isNotBlank() && step.smsToken.isNotBlank()) { step.message.ifBlank { "发送短信失败，请稍后重试" } }
            return JSONObject().put("creditKey", step.smsCreditKey).put("smsToken", step.smsToken).put("message", step.message)
        }
        val step = if (mode == "password") {
            require(params.optString("password").isNotBlank()) { "请输入密码" }
            xunleiApi.loginWithPassword(account, params.getString("password"), device)
        } else {
            require(params.optString("code").isNotBlank()) { "请输入短信验证码" }
            require(params.optString("creditKey").isNotBlank() && params.optString("smsToken").isNotBlank()) { "请先发送短信验证码" }
            xunleiApi.smsLogin(account, params.getString("code"), params.getString("creditKey"), params.getString("smsToken"), device)
        }
        if (step.sessionId.isBlank()) return JSONObject().put("loggedIn", false).put("message", step.message.ifBlank { "请发送短信完成设备验证" }).put("reviewUrl", step.reviewUrl)
        val captcha = xunleiApi.initCaptcha(device, account) ?: error("获取验证凭证失败，请在网页登录完成验证后重试")
        val tokens = xunleiApi.exchangeToken(step.sessionId, device, captcha) ?: error("换取登录凭证失败，请重新登录")
        val record = JSONObject().put("accessToken", tokens.first).put("refreshToken", tokens.second)
            .put("deviceId", device).put("captchaToken", captcha).put("nickname", step.nickname.ifBlank { "迅雷用户" })
        updateCredential("xunlei", record)
        return JSONObject().put("loggedIn", true).put("record", record)
    }

    private fun register(context: Context): String {
        // 文件引用与会话一起淘汰，避免长时间浏览导致无上限驻留。
        if (contexts.size >= 32 || entries.size >= 20_000) { contexts.clear(); entries.clear() }
        val id = UUID.randomUUID().toString()
        contexts[id] = context
        return id
    }
    private fun result(id: String, context: Context, directory: String, items: JSONArray) = JSONObject()
        .put("sessionId", id).put("platform", context.platform).put("title", context.title)
        .put("directory", directory).put("items", items)

    private suspend fun resolveGitHub(link: GitHubLinkType): JSONObject = when (link) {
        is GitHubLinkType.DirectFile -> {
            val context = Context("github", title = link.fileName)
            val id = register(context)
            val ref = UUID.randomUUID().toString()
            entries[ref] = Entry(context, ShareFile("", link.fileName, 0, false, "", ""), link.url)
            result(id, context, "0", JSONArray().put(JSONObject().put("ref", ref).put("name", link.fileName).put("size", 0).put("isDir", false)))
        }
        is GitHubLinkType.Account -> githubAccount(link.owner)
        is GitHubLinkType.Repository -> {
            val info = githubJson("https://api.github.com/repos/${link.owner}/${link.repo}")
            val branch = info.optString("default_branch", "main")
            val context = Context("github", owner = link.owner, repository = link.repo, ref = branch, title = "${link.owner}/${link.repo}", privateRepo = info.optBoolean("private"))
            val id = register(context)
            val sub = link.subPath.orEmpty()
            if (sub.startsWith("releases")) githubReleases(id, context)
            else {
                val parts = sub.split('/').filter { it.isNotBlank() }
                if (parts.firstOrNull() in setOf("tree", "blob") && parts.size >= 2) {
                    val changed = context.copy(ref = parts[1])
                    contexts[id] = changed
                    githubList(id, changed, parts.drop(2).joinToString("/"))
                } else githubList(id, context, "")
            }
        }
    }

    private suspend fun githubAccount(owner: String, authenticated: Boolean = false): JSONObject {
        val context = Context("github", owner = owner, title = "$owner · 仓库")
        val id = register(context)
        val type = if (authenticated) "User" else githubJson("https://api.github.com/users/$owner").optString("type")
        val base = if (authenticated) "https://api.github.com/user/repos?sort=updated" else
            "https://api.github.com/${if (type == "Organization") "orgs" else "users"}/$owner/repos?sort=updated"
        val items = JSONArray()
        for (page in 1..10) {
            val array = githubArray("$base&per_page=100&page=$page")
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                items.put(JSONObject().put("name", obj.getString("full_name")).put("isDir", true)
                    .put("id", "repo:${obj.getString("full_name")}").put("size", 0).put("modified", obj.optString("updated_at")))
            }
            if (array.length() < 100) break
        }
        return result(id, context, "", items)
    }

    private suspend fun githubList(id: String, context: Context, directory: String): JSONObject {
        if (directory.startsWith("repo:")) {
            val parts = directory.removePrefix("repo:").split('/')
            return resolveGitHub(GitHubLinkType.Repository(parts[0], parts[1], null))
        }
        if (directory == "@releases") return githubReleases(id, context)
        val prefix = "https://api.github.com/repos/${context.owner}/${context.repository}/contents/"
        val raw = githubBody(prefix + encodePath(directory) + "?ref=" + java.net.URLEncoder.encode(context.ref, "UTF-8"))
        val array = if (raw.trimStart().startsWith("[")) JSONArray(raw) else JSONArray().put(JSONObject(raw))
        val items = JSONArray()
        for (i in 0 until array.length()) {
            val obj = array.getJSONObject(i)
            val folder = obj.optString("type") == "dir"
            val ref = UUID.randomUUID().toString()
            if (!folder) {
                var url = obj.optString("download_url")
                if (url.isBlank()) url = "https://raw.githubusercontent.com/${context.owner}/${context.repository}/${encodePath(context.ref)}/${encodePath(obj.getString("path"))}"
                entries[ref] = Entry(context, ShareFile(obj.getString("path"), obj.getString("name"), obj.optLong("size"), false, "", ""), url)
            }
            items.put(JSONObject().put("id", obj.optString("path")).put("ref", ref).put("name", obj.optString("name"))
                .put("size", obj.optLong("size")).put("isDir", folder).put("modified", ""))
        }
        if (directory.isBlank()) {
            items.put(JSONObject().put("id", "@releases").put("name", "Releases · 发布文件").put("isDir", true).put("size", 0))
            val ref = UUID.randomUUID().toString()
            val name = "${context.repository}-${context.ref.replace('/', '-')}.zip"
            entries[ref] = Entry(context, ShareFile("", name, 0, false, "", ""), "https://api.github.com/repos/${context.owner}/${context.repository}/zipball/${encodePath(context.ref)}")
            items.put(JSONObject().put("ref", ref).put("name", name).put("size", 0).put("isDir", false))
        }
        return result(id, context, directory, items)
    }

    private suspend fun githubReleases(id: String, context: Context): JSONObject {
        val releases = githubArray("https://api.github.com/repos/${context.owner}/${context.repository}/releases?per_page=100")
        val items = JSONArray()
        for (i in 0 until releases.length()) {
            val release = releases.getJSONObject(i)
            val assets = release.optJSONArray("assets") ?: continue
            for (j in 0 until assets.length()) {
                val asset = assets.getJSONObject(j)
                val ref = UUID.randomUUID().toString()
                val url = if (context.privateRepo) asset.getString("url") else asset.getString("browser_download_url")
                entries[ref] = Entry(context, ShareFile("", asset.getString("name"), asset.optLong("size"), false, "", ""), url)
                items.put(JSONObject().put("ref", ref).put("name", asset.getString("name")).put("size", asset.optLong("size"))
                    .put("isDir", false).put("modified", release.optString("tag_name")))
            }
        }
        return result(id, context, "@releases", items)
    }

    /** 一次列表只调用 contents，避免对每个文件额外查询提交时间耗尽额度。 */
    private suspend fun githubBody(url: String, token: String = value("github")): String = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url).header("User-Agent", "YunX-Windows")
            .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28")
        if (token.isNotBlank()) builder.header("Authorization", "Bearer $token")
        HttpClients.apiClient().newCall(builder.build()).execute().use { response ->
            when (response.code) {
                401 -> error("GitHub Token 无效或已过期，请重新配置")
                403, 429 -> error("GitHub 请求被限制或无访问权限，请配置 Token 或稍后重试")
                404 -> error("GitHub 仓库或路径不存在，私有仓库需要有权限的 Token")
            }
            check(response.isSuccessful) { "GitHub 请求失败（HTTP ${response.code}）" }
            response.body?.string() ?: error("GitHub 返回空响应")
        }
    }
    private suspend fun githubJson(url: String, token: String = value("github")) = JSONObject(githubBody(url, token))
    private suspend fun githubArray(url: String) = JSONArray(githubBody(url))
    private fun encodePath(path: String) = path.split('/').joinToString("/") { java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20") }

    companion object {
        val PLATFORMS = setOf("quark", "uc", "xunlei", "c139", "pan123", "github")
        val NAMES = mapOf("quark" to "夸克网盘", "uc" to "UC 网盘", "xunlei" to "迅雷网盘", "c139" to "139 网盘", "pan123" to "123 云盘", "github" to "GitHub")
    }
}

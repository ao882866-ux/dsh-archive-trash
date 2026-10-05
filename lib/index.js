/**
 * dsh-archive-trash —— 归档会话管理插件（宿主侧）。
 *
 * 提供 4 个能力：列出 / 检索归档会话、恢复（取消归档）、删除。
 *
 * ## 为什么删除必须自己实现
 *
 * DSH **没有**会话删除 API：`ctx.sessionQuery` 只有读，`ctx.workspaceRegistry`
 * 只有 archive/unarchive（归档是「从工作区分组界面隐藏」，**不删数据**）。
 * 因此删除只能操作磁盘：
 *
 * - 会话日志目录 `$DSH_HOME/sessions/<转义 cwd>/<sessionId>/`
 * - 投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`
 * - 工作区归属（`Workspace.detachSession`）
 * - 归档集合（`unarchiveSession`）
 *
 * ## 安全约定（真实风险，不是形式）
 *
 * 1. **只允许删除「当前确实处于归档状态」的会话**。判据是 id ∈ 归档集合，
 *    在宿主侧校验 —— 否则一个伪造的 RPC 就能删掉任意会话。
 * 2. **id 必须先通过形态校验**（`isPlausibleSessionId`）：id 会被拼进文件路径，
 *    放行 `../` 就等于任意文件删除。
 * 3. **先删文件并确认删净，最后才摘归档标记与工作区归属**。
 *
 *    ⚠️ 这个顺序**曾经是反的**，而那正是「点击删除后会话又回到未归档列表」的
 *    根因：先取消归档、再删文件，一旦删文件失败（文件被占用 / EPERM /
 *    瞬时 I/O 错误），结果就是「会话还在磁盘上，但已经不再归档」——
 *    DSH 于是把它当作一个**普通会话**列出来，用户看到的就是「删了又回到
 *    未归档列表」。更糟的是此后宿主会以「不在归档集合中」拒绝再次删除，
 *    于是这条会话既删不掉、又一直占着列表，功能彻底失效。
 *
 *    改成「先删数据、最后摘标记」后，失败方向变成「会话原样还在、仍然归档」，
 *    重试即可。若只在摘标记那一步失败，留下的是「文件已没了、归档集合还在」
 *    的幽灵条目 —— 这种条目**本插件仍然允许删除**（见 `dirs.length === 0`
 *    的分支），所以同样可恢复。
 * 4. **正在运行的会话拒绝删除**：DSH 的写路径持有单写者句柄，日志被抽走会让
 *    下一次 append 失败，表现为会话无故损坏。
 * 5. **删文件之前先把「活着的会话」从 `ctx.sessions` 摘除**。否则
 *    `sessionQuery.listSessions()` 仍会从内存（`ctx.sessions.list()`）把它
 *    列出来；而归档标记此时已被摘掉，于是它会以**未归档**身份出现在侧栏
 *    —— 与第 3 条是同一症状的第二条独立成因。摘除还会触发
 *    `session/disposed`，进而让持久化写入句柄 `close()`（释放单写者租约，
 *    避免删除后又被后台 append 重建出日志文件），并让客户端丢弃该行。
 * 6. **删主会话时必须级联删除它的子代理会话**。子代理（智能体团队）会话是
 *    `origin === 'subagent'` 的独立会话，有自己的日志目录与投影缓存；只删主会话
 *    会把它们留成**孤儿** —— 用户报障「删除会话后子代理会话会留下来」。
 *    判据与 DSH 自己一致（见 `collectSubagentDescendants` 的注释）：
 *    `origin === 'subagent'` **且** `parentSession === 主会话 id`。
 *    ⚠️ 只看 `parentSession` 会误删 **fork**（分叉是独立会话，用户还要接着聊）。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  buildRows,
  buildWorkspaceIndex,
  collectSubagentDescendants,
  deletableIssue,
  isPlausibleSessionId,
  isSafePathSegment,
  summarize,
  workspaceTitleFor,
} from './pure.js'

export const name = 'session-archive'

/**
 * 刻意**不**把 `connection` 列进静态 inject。
 *
 * 与 dsh-codearts-auth 同理：`connection` 只由 Web bundle 提供，headless / CLI
 * profile 里不存在。静态 inject 会让插件在那些 profile 里永久 pending，进而
 * 整个 profile 以「1 entry did not activate」启动失败。RPC 端点改为在 apply
 * 内用 `ctx.inject(['connection'], ...)` 可选挂载 —— 拿不到就只是没有 HTTP
 * 端点，插件的服务本身仍可用。
 */
export const inject = []

/** RPC 通道：宿主注册 `/api/session-archive`，客户端按同名 endpoint 调用。 */
export const SESSION_ARCHIVE_API_PATH = '/api/session-archive'
const SESSION_ARCHIVE_ENDPOINT = 'session-archive'

/** DSH 主目录。`DSH_HOME` 优先，否则 `~/.dsh`。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** 读一个 JSON 文件；不存在或损坏都返回 undefined（调用方必须能接受）。 */
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 读工作区注册表文档。
 *
 * ⚠️ 直接读 `$DSH_HOME/storages/workspace.json` 而**不是**问服务：
 * `workspaceRegistry` 只暴露 archive/unarchive 与工作区投影，
 * **没有**「列出归档集合」的方法（归档集合只通过 `workspaceController.follow`
 * 的 baseline 或各写操作的返回值流出）。而这份文档正是那两个来源的真相源。
 */
async function readWorkspaceDocument() {
  const file = path.join(dshHome(), 'storages', 'workspace.json')
  const doc = await readJson(file)
  if (doc === null || typeof doc !== 'object') return undefined
  const global = doc.global ?? {}
  const archived = Array.isArray(global.archivedSessionIds)
    ? global.archivedSessionIds.filter((id) => typeof id === 'string')
    : []
  const tables = doc.tables ?? {}
  const workspacesTable = tables.workspaces ?? {}
  const workspaces = []
  for (const value of Object.values(workspacesTable)) {
    if (value === null || typeof value !== 'object') continue
    workspaces.push({
      path: typeof value.path === 'string' ? value.path : undefined,
      title: typeof value.title === 'string' ? value.title : undefined,
      sessionIds: Array.isArray(value.sessionIds) ? value.sessionIds : [],
    })
  }
  return { archived, workspaces }
}

/**
 * 建立「会话 id → 日志目录列表」索引。
 *
 * 会话目录是 `sessions/<按 cwd 转义的目录名>/<sessionId>/`，转义规则是 DSH 内部
 * 实现细节（`--E-AM--` 这种），**不可反推**。故这里只扫一层：把每个一级子目录的
 * 名字当作候选会话 id，而不是尝试解码目录名去定位。
 *
 * ⚠️ 值刻意是**数组**而不是单一路径：删除时若只删「第一个」目录，同名会话在
 * 另一个 bucket 下的副本会活下来 —— 于是文件还在、会话又回到列表里，正是本次
 * 要修的故障形态。列表展示仍只用 `[0]`（见 `buildRow`）。
 */
async function indexSessionDirs() {
  const root = path.join(dshHome(), 'sessions')
  const index = new Map()
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return index
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const bucket = path.join(root, entry.name)
    let children
    try {
      children = await fs.readdir(bucket, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const full = path.join(bucket, child.name)
      const existing = index.get(child.name)
      if (existing === undefined) index.set(child.name, [full])
      else existing.push(full)
    }
  }
  return index
}

/** 路径是否存在（只判存在，不关心类型）。 */
async function pathExists(target) {
  try {
    await fs.stat(target)
    return true
  } catch {
    return false
  }
}

/** zstd 帧魔数。DSH 的会话日志是**多帧** zstd，且每帧一行头/事件。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 只读日志文件开头的一小段，解出**第一帧**并返回第一行。
 *
 * 为什么只读开头而不是整个文件：会话日志可以到几 MB（实测最大 5.5MB），
 * 而我们只需要第一行（会话头）。实测前 8KB 足够解出全部 84 个会话的头。
 *
 * 多帧 zstd 必须**按帧切**：`zstdDecompressSync` 一次只解一帧，
 * 直接喂整个文件会只得到第一帧之后报错（这是本项目踩过的坑）。
 */
async function readFirstLogLine(logPath, headBytes = 65536) {
  let handle
  try {
    handle = await fs.open(logPath, 'r')
    const buffer = Buffer.alloc(headBytes)
    const { bytesRead } = await handle.read(buffer, 0, headBytes, 0)
    const chunk = buffer.subarray(0, bytesRead)
    const start = chunk.indexOf(ZSTD_MAGIC)
    if (start === -1) return undefined
    const next = chunk.indexOf(ZSTD_MAGIC, start + 4)
    const end = next === -1 ? chunk.length : next
    const text = zlib.zstdDecompressSync(chunk.subarray(start, end)).toString('utf8')
    return text.split('\n').find((line) => line.trim().length > 0)
  } catch {
    // 损坏 / 截断 / 未压缩的日志都只是「读不到血缘」，不该让删除整体失败。
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * 解析一行会话头 JSON。
 *
 * 磁盘上的形状是 `{"type":"session","version":4,"id":...,"origin":"subagent",...}`
 * —— 字段就在**顶层**（不是包在 `header` 里）。但 DSH 内部另有
 * `{header: {...}}` 的包装形态，两种都认，避免上游改形后静默失效。
 */
function parseSessionHeader(line) {
  if (typeof line !== 'string' || line.length === 0) return undefined
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const header = value.header ?? value.record?.header ?? value
  if (header === null || typeof header !== 'object') return undefined
  if (typeof header.id !== 'string') return undefined
  return header
}

/**
 * 枚举全部会话头（用于解析子代理血缘）。
 *
 * ## 磁盘是唯一权威来源
 *
 * 会话头的 `id` 字段是**日志文件里的自称**，而我们要删的是**磁盘目录**。
 * 两者不一致时，必须信目录。这不是洁癖，是实测确认过的**真实误删**：
 * 某个目录里的日志被改写后声称自己是另一个会话 id，血缘遍历就会把这个
 * 谎报的 id 当成主会话的子代理，进而删掉**那个无辜会话**的目录 ——
 * 两个会话其实毫无关系。
 *
 * 因此：
 * 1. **先扫磁盘**，且只接受 `header.id === 所在目录名` 的头（这正是 DSH 自己的
 *    不变量，见 `dsh-session-persistence-jsonl` 的 `assertStoredId`）；
 * 2. `ctx.sessionPersistence.list()` **只作为补漏**，且**不得覆盖**磁盘已确认的头
 *    —— 否则它会把被污染的头塞进来，让第 1 步白做。
 *
 * ⚠️ 必须能容忍两者都失败：血缘解析失败只会退化成「不级联删子代理」，
 * 而**不该**让主会话也删不掉。
 */
async function readSessionHeaders(ctx) {
  const headers = new Map()

  // 1. 磁盘扫描（权威）：只认「头里的 id 与目录名一致」的会话。
  let dirs = new Map()
  try {
    dirs = await indexSessionDirs()
    for (const [dirName, paths] of dirs) {
      // ⚠️ 目录名来自磁盘，用**路径安全**校验（不能用形态校验：
      // 真实存在 `fusion-worker-<uuid>` 这类非 uuid 形态的会话目录）。
      if (!isSafePathSegment(dirName)) continue
      const line = await readFirstLogLine(path.join(paths[0], 'session.v4.jsonl.zstd'))
      const header = parseSessionHeader(line)
      if (header === undefined) continue
      // ⚠️ 键用**目录名**，且要求与自称的 id 一致 —— 见函数注释。
      if (header.id !== dirName) continue
      headers.set(dirName, header)
    }
  } catch {
    // 扫描失败：下面仍尝试用服务补漏。
  }

  // 2. 服务补漏：仅补齐磁盘上读不到头的会话，**绝不覆盖**已确认的头。
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list({})
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const header = snapshot?.header
        if (header === null || typeof header !== 'object' || typeof header.id !== 'string') continue
        if (!isSafePathSegment(header.id)) continue
        if (headers.has(header.id)) continue
        // 磁盘上必须真的有这个会话的目录，否则删不到任何东西，也不该参与血缘。
        if (dirs.size > 0 && !dirs.has(header.id)) continue
        headers.set(header.id, header)
      }
    } catch {
      // 服务不可用：磁盘扫描的结果已经够用。
    }
  }

  return headers
}

/**
 * 找出 `sessionId` 的**全部子代理后代**（深的在前，可直接按序删除）。
 *
 * ⚠️ 血缘判据是 `origin === 'subagent'` 且 `parentSession === sessionId`
 * —— 与 DSH 自己一致。只看 `parentSession` 会把 **fork** 误当成子代理，
 * 而 fork 是独立会话，删原会话不该连带删它（用户还要接着聊）。
 *
 * ⚠️ 结果还会**再过滤一次**：只保留在磁盘上**确实存在日志目录**的 id。
 * 血缘数据可能来自被改写过的头（谎报 id / 谎报 parentSession），
 * 而我们要删的是磁盘目录 —— 磁盘上没有对应目录的 id 一律不删，
 * 这样即使血缘被污染也无法波及无关会话。
 *
 * 血缘读取失败时返回 `[]`（只删主会话），并**不**阻断删除 —— 宁可留下
 * 孤儿子代理让用户手动清理，也不能因为解析不了血缘就整个删不掉。
 */
async function findSubagentDescendants(ctx, sessionId) {
  try {
    const headers = await readSessionHeaders(ctx)
    const candidates = collectSubagentDescendants([...headers.values()], sessionId)
    if (candidates.length === 0) return []
    // 只保留磁盘上真实存在的会话（目录名即事实），并顺带过滤掉重复项。
    const dirs = await indexSessionDirs()
    const verified = []
    for (const id of candidates) {
      if (!dirs.has(id)) continue
      if (!verified.includes(id)) verified.push(id)
    }
    return verified
  } catch {
    return []
  }
}

/** 等待若干毫秒（用于让持久化写入句柄先关掉，见 `deleteSession` 第 1 步）。 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 递归删除一个目录，并在**确认删净**后才返回。
 *
 * 重试是必要的：`ctx.sessions` 摘除会异步触发 `session/disposed`，持久化写入
 * 句柄的 `close()` 是 fire-and-forget 的 —— 它可能在我们删完之后才把缓冲事件
 * 落盘，从而**把日志文件重新建出来**（会话「复活」）。故删除后必须复核存在性，
 * 仍在则重试；最终仍在就抛错，交由调用方放弃并保持归档状态。
 */
async function removeTree(target, attempts = 5) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true })
      if (!(await pathExists(target))) return
      lastError = new Error(`目录删除后仍存在：${target}`)
    } catch (error) {
      lastError = error
    }
    await delay(60 * (attempt + 1))
  }
  throw lastError ?? new Error(`无法删除目录：${target}`)
}

/**
 * 把活着的会话从内存注册表摘除。
 *
 * ⚠️ 不摘除的话 `sessionQuery.listSessions()` 仍会从 `ctx.sessions.list()`
 * 把它列出来；而归档标记此时已被摘掉，于是它以**未归档**身份出现在侧栏 ——
 * 「删了又回到未归档列表」的第二条独立成因。
 *
 * 摘除还会发出 `session/disposed`，进而：持久化写入句柄 `close()`（释放单写者
 * 租约，避免删除后又被后台 append 重建日志），以及会话控制器转发
 * `api-session/removed` 让客户端立即丢弃该行。
 *
 * @returns 是否真的摘掉了一个活动条目。
 */
function evictLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined || typeof sessions.get !== 'function') return false
  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    return false
  }
  if (session === undefined || session === null) return false
  try {
    if (typeof sessions.liveEntryFor !== 'function' || typeof sessions.detachEntered !== 'function') return false
    const entry = sessions.liveEntryFor(session)
    sessions.detachEntered(entry)
    return true
  } catch {
    // 已经不在 store 里（或不是 live 实例）：无需摘除，不是错误。
    return false
  }
}

/**
 * 等持久化写入句柄的排空安定下来。
 *
 * `session/disposed` 监听器里的 `writer.close()` 没有被 await，故摘除之后要主动
 * 等一拍再删文件；`flush()` 是服务公开的排空屏障，失败也不阻断删除。
 */
async function settlePersistence(ctx) {
  const persistence = ctx.get('sessionPersistence')
  try {
    if (typeof persistence?.flush === 'function') await persistence.flush()
  } catch {
    // 排空失败不该阻断删除：下面还有「删后复核 + 重试」兜底。
  }
  await delay(50)
}

/** 递归求目录总字节数；失败按 0 计（展示用，不影响判定）。 */
async function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await directorySize(full)
      else if (entry.isFile()) total += (await fs.stat(full)).size
    } catch {
      // 单文件读取失败不拖垮整体。
    }
  }
  return total
}

/**
 * 把 `candidate` 限制在 `base` 目录内；越界则返回 `undefined`。
 *
 * 这是**结构性**防护：不再依赖「调用方已经校验过 id」，而是让路径本身
 * 无法逃出基目录。`path.resolve` 会解析 `..` 与绝对路径，再比对前缀。
 *
 * ⚠️ 比较时必须带 `path.sep`：否则 `C:\base-evil` 会被误判成在 `C:\base` 内。
 */
function containedPath(base, candidate) {
  const root = path.resolve(base)
  const target = path.resolve(candidate)
  if (target === root) return target
  return target.startsWith(root + path.sep) ? target : undefined
}

/**
 * 投影缓存文件路径。文件名就是会话 id（含或不含 `session-` 前缀都可能）。
 *
 * ⚠️ 会话 id 会被拼进路径，而级联删除的 id 来自**磁盘会话头**（不可信输入）。
 * 故这里返回 `undefined` 表示「越界，拒绝操作」，调用方必须判空。
 */
function projectionCachePath(sessionId) {
  const base = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  return containedPath(base, path.join(base, `${sessionId}.json`))
}

/**
 * 取会话标题。
 *
 * 两条来源，**顺序刻意如此**：
 * 1. `ctx.sessionQuery.readTitleSnapshots` —— 权威且 live-preferred，
 *    能反映尚未落进投影缓存的最新改名；
 * 2. 投影缓存文件 —— 服务不可用（headless / 单测替身）时的保底，
 *    内容与 GUI 侧栏显示的是同一份。
 */
async function readTitles(ctx, ids) {
  const titles = new Map()
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.readTitleSnapshots === 'function') {
    try {
      const results = await query.readTitleSnapshots(ids)
      for (const result of Array.isArray(results) ? results : []) {
        if (result?.status !== 'fulfilled') continue
        const title = result.value?.title
        if (title !== undefined && typeof title.title === 'string') {
          titles.set(result.sessionId, { title: title.title, source: title.source?.kind ?? 'unknown' })
        }
      }
    } catch {
      // 整体失败时逐条回退到投影缓存。
    }
  }
  for (const id of ids) {
    if (titles.has(id)) continue
    const cachePath = projectionCachePath(id)
    if (cachePath === undefined) continue
    const cached = await readJson(cachePath)
    const title = cached?.record?.rows?.title?.val
    if (typeof title === 'string' && title.length > 0) {
      titles.set(id, { title, source: 'projection-cache' })
    }
  }
  return titles
}

/** 组装一行归档会话的完整元数据。 */
async function buildRow(ctx, sessionId, context) {
  const dir = context.dirs.get(sessionId)?.[0]
  const header = context.headers.get(sessionId)
  const titleInfo = context.titles.get(sessionId)
  const cwd = header?.cwd ?? ''
  const stat = context.stats.get(sessionId)
  const sizeBytes = stat?.sizeBytes ?? (dir !== undefined ? await directorySize(dir) : 0)
  return {
    sessionId,
    title: titleInfo?.title ?? '(无标题)',
    titleSource: titleInfo?.source ?? 'unknown',
    cwd,
    workspaceTitle: workspaceTitleFor(context.workspaceIndex, cwd, sessionId) ?? '',
    createdAt: header?.createdAt ?? 0,
    updatedAt: stat?.updatedAt ?? header?.createdAt ?? 0,
    sizeBytes,
    eventCount: stat?.eventCount ?? 0,
    // ⚠️ `live`（有活动 agent）与 `running`（正在跑一轮）**必须分开**：
    // 会话跑完后 agent 仍以 idle 挂在注册表里，故 `live` 恒为真。
    // 早期只取「agent 是否存在」当运行判据，导致**所有已完成会话都被误报
    // 成运行中、无法删除**（用户报障）。
    live: context.liveIds.has(sessionId),
    running: context.runningIds.has(sessionId),
    persisted: header !== undefined || dir !== undefined,
    archived: true,
    exists: dir !== undefined,
  }
}

/**
 * 收集全部归档会话的行数据。
 *
 * 每条来源都**容错**：任一服务缺失（headless / 单测）或单个会话读取失败，
 * 都只让该字段退化为默认值，绝不让整次列表失败 —— 否则用户会看到
 * 「归档管理页一片空白」且无从判断原因。
 */
async function collectRows(ctx) {
  const doc = await readWorkspaceDocument()
  const archived = doc?.archived ?? []
  const workspaceIndex = buildWorkspaceIndex(doc?.workspaces ?? [])
  const dirs = await indexSessionDirs()

  // 「运行中」判据：**只认 `agent.status === 'running'`**。
  //
  // ⚠️ 这正是 DSH 自己的判据（`dsh-api-session-controller` 的 `summaryFor`：
  // `running: this.ctx.agents.get(session.id)?.status === "running"`）。
  // 早期这里写成「`agents.get(id) !== undefined` 就算运行中」，那是**错的**：
  // agent 在会话跑完后仍以 `idle` 挂在注册表里，于是**所有已完成会话都被
  // 误报成「运行中」并禁止删除**（用户报障）。
  //
  // 优先用 `sessionController.list()`（权威、已算好 running），失败或不可用时
  // 退回直接读 `agents.get(id).status`。两者都不行则一律视为**未运行** ——
  // 删除路径还有「单写者句柄」兜底，而误判成运行中会让用户完全无法清理。
  const liveIds = new Set()
  const runningIds = new Set()
  const agents = ctx.get('agents')

  // 权威来源：`sessionController.list()`（已算好 running / agentAvailable）。
  const summaries = await readSessionSummaries(ctx)
  if (summaries !== undefined) {
    for (const item of summaries) {
      const id = item?.sessionId
      if (typeof id !== 'string') continue
      if (item.agentAvailable === true) liveIds.add(id)
      if (item.running === true) runningIds.add(id)
    }
  }

  // 补全 controller 没覆盖到的（或它整体不可用时的）情形。
  if (agents !== undefined && typeof agents.get === 'function') {
    for (const id of archived) {
      if (runningIds.has(id) && liveIds.has(id)) continue
      try {
        const agent = agents.get(id)
        if (agent === undefined) continue
        liveIds.add(id)
        // 只认 'running'；'idle' 表示跑完了，不该阻断删除。
        if (agent.status === 'running') runningIds.add(id)
      } catch {
        // 单个查询失败不影响其余。
      }
    }
  }

  // 头信息与事件数：sessionPersistence 是权威来源。
  const headers = new Map()
  const stats = new Map()
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined) {
    for (const id of archived) {
      if (typeof persistence.stat !== 'function') break
      try {
        const snapshot = await persistence.stat(id)
        if (snapshot !== undefined) {
          headers.set(id, snapshot.header)
          stats.set(id, {
            eventCount: snapshot.eventCount ?? 0,
            sizeBytes: snapshot.sizeBytes ?? 0,
            updatedAt: snapshot.header?.createdAt ?? 0,
          })
        }
      } catch {
        // 单条失败不影响其余。
      }
    }
  }

  const titles = await readTitles(ctx, archived)
  const context = { dirs, headers, stats, titles, workspaceIndex, liveIds, runningIds }
  const raw = []
  for (const id of archived) raw.push(await buildRow(ctx, id, context))

  // 「最后活动时间」优先采信投影缓存文件的 mtime：它是「这个会话最后一次被写」
  // 的直接证据，比 header.createdAt（**创建**时间）更贴近用户感知的
  // 「我上次用它是什么时候」。取不到时保留 persistence/header 的时间。
  const rows = buildRows(raw)
  const byId = new Map(rows.map((row) => [row.sessionId, row]))
  for (const id of archived) {
    const row = byId.get(id)
    if (row === undefined) continue
    const cachePath = projectionCachePath(id)
    if (cachePath === undefined) continue
    try {
      const info = await fs.stat(cachePath)
      if (info.mtimeMs > row.updatedAt) row.updatedAt = info.mtimeMs
    } catch {
      // 无缓存文件：保留 persistence/header 的时间。
    }
  }
  return { rows: buildRows(rows), summary: summarize(rows), workspaceIndex }
}

/** 归档集合（权威，用于删除前的强校验）。 */
async function readArchivedIds() {
  const doc = await readWorkspaceDocument()
  return new Set(doc?.archived ?? [])
}

/**
 * 「删除」一个归档会话 —— **直接永久删除，不可恢复**。
 *
 * 用户明确要求：不要回收站，确认后直接彻底删除。
 *
 * ## 顺序（这是本次修复的核心）
 *
 * **先摘除活着的会话 → 再删文件并确认删净 → 最后才摘归档标记与工作区归属。**
 *
 * ⚠️ 这个顺序**曾经是反的**（先取消归档、再删文件），而那正是
 * 「点击删除后会话又回到未归档列表」的根因：一旦删文件失败（被占用 / EPERM /
 * 瞬时 I/O），结果就是「会话还在磁盘上，但已经不再归档」—— DSH 于是把它当作
 * 一个**普通会话**列出来。更糟的是此后宿主会以「不在归档集合中」拒绝再次删除，
 * 于是这条会话既删不掉、又一直占着列表，功能彻底失效。
 *
 * 改成现在这个顺序后：
 * - 删文件失败 → 会话**原样还在、仍然归档**，用户可重试；
 * - 只有摘标记失败 → 留下「文件已删净、归档集合还在」的幽灵条目，而这种条目
 *   本插件仍然允许删除（`dirs` 为空也能走完），所以同样可恢复。
 *
 * 无论走哪条失败路径，都**绝不会**留下「不再归档、却还在磁盘上」的会话 ——
 * 那正是用户看到「回到未归档列表」的形态。
 *
 * 安全边界（都在调用方 `handleSessionArchiveRpc` 里复核，客户端判断不作数）：
 * 1. 只允许删**当前确实已归档**的会话；
 * 2. id 必须通过形态校验（会被拼进路径，放行 `../` 等于任意文件删除）；
 * 3. 正在跑一轮的会话拒绝删除（抽走日志会让写路径损坏）。
 *
 * ## 级联：先删子代理，再删主会话
 *
 * 子代理（智能体团队）会话是独立会话，有自己的日志目录与投影缓存。只删主会话
 * 会把它们留成**孤儿**（用户报障）。故这里按「**深的子代理在前**」的顺序逐个
 * 删除，最后才删主会话本身。
 *
 * ⚠️ 级联是**严格**的：任何一个子代理删失败就整体抛错、**不碰主会话**。
 * 这样保证「主会话一旦被删，它的子代理一定已经全部删净」——
 * 若反过来（先删主会话、子代理失败），子代理就再也没法通过父会话被找到，
 * 只能永久留在磁盘上，正是用户报的故障。失败时主会话保持归档，重试即可。
 */
async function deleteSession(ctx, sessionId) {
  // 1. 先找出全部子代理后代（深的在前）。
  const descendants = await findSubagentDescendants(ctx, sessionId)

  // 目录索引只建一次：`deleteSessionOne` 每个会话都要用，而扫描整棵
  // `sessions/` 树是 O(会话数)。各会话的 id → 目录映射互不影响，
  // 故删掉一个后复用同一份索引是安全的。
  const dirs = await indexSessionDirs()

  // 子代理正常**不在**归档集合里（侧栏对 `origin === 'subagent'` 的行直接不显示，
  // 所以用户没法归档它们）。但这里仍按实际情况判断：万一某个子代理确实在集合里
  // （历史数据 / 手工改过 workspace.json），删掉文件却不摘标记就会留下**幽灵条目**
  // —— 与主会话同一个坑，故一律以「它是否真的在集合里」为准。
  const archivedIds = await readArchivedIds()

  // 2. 先删子代理。任一失败就抛错 —— 此时主会话**尚未被触碰**，仍保持归档。
  const subagents = { deleted: [], failed: [] }
  for (const childId of descendants) {
    try {
      // ⚠️ 正在跑的子代理不能删：抽走日志会让它的写路径损坏
      // （与主会话同一条安全边界）。此时整体中止，主会话保持归档。
      if (await isSessionRunning(ctx, childId)) {
        throw new Error('该子代理会话正在运行，请先停止后再删除主会话')
      }
      const removed = await deleteSessionOne(ctx, childId, {
        // 只在它确实位于归档集合里时才摘标记。
        detachArchiveMark: archivedIds.has(childId),
        dirs,
      })
      subagents.deleted.push({ sessionId: childId, removed })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      subagents.failed.push({ sessionId: childId, reason })
      // 严格级联：宁可整体失败（主会话仍归档、可重试），也不留下孤儿。
      const failure = new Error(`子代理会话 ${childId} 删除失败，已中止（主会话仍保持归档）：${reason}`)
      failure.subagents = subagents
      throw failure
    }
  }

  // 3. 子代理全部删净后，才删主会话。
  const removed = await deleteSessionOne(ctx, sessionId, { detachArchiveMark: true, dirs })
  return { ...removed, subagents }
}

/**
 * 删除**单个**会话的磁盘状态（不处理级联）。
 *
 * 顺序与失败方向见 `deleteSession` 的注释：先摘内存 → 删文件并确认删净 →
 * 最后才摘归档标记与工作区归属。
 *
 * @param options.detachArchiveMark - 是否要调 `unarchiveSession`。
 *   主会话为 `true`；子代理会话不在归档集合里，为 `false`
 *   （对它们调取消归档既无意义，也可能被服务拒绝）。
 * @param options.dirs - 预先建好的「会话 id → 目录列表」索引。级联删除时由
 *   `deleteSession` 复用一份，避免每个会话都重扫整棵 `sessions/` 树。
 */
async function deleteSessionOne(ctx, sessionId, options = {}) {
  const { detachArchiveMark = true, dirs } = options
  // ⚠️ 纵深防御：这是所有删除路径的**唯一收口**，所以在这里再校验一次。
  // 级联删除的 id 来自磁盘会话头（不可信输入），而下面每个路径拼接都用到它。
  // 放行 `../` 就等于「删掉任意文件」—— 已实测确认过，故不依赖上游是否校验。
  //
  // 用**路径安全**校验而非形态校验：真实数据里有 `fusion-worker-<uuid>` 这类
  // 非 uuid 形态的会话目录，用形态校验会让它们删不掉（子代理残留）。
  if (!isSafePathSegment(sessionId)) {
    throw new Error(`拒绝删除形态非法的会话 id：${String(sessionId)}`)
  }
  const removed = {
    archivedMark: false,
    workspaceDetached: false,
    logDirectory: false,
    projectionCache: false,
    liveEvicted: false,
  }

  // 1. 先把活着的会话从内存摘除。
  //    ⚠️ 必须在删文件**之前**：摘除会触发持久化写入句柄 close()，释放单写者
  //    租约；否则后台 append 可能在删完之后把日志文件重建出来（会话复活）。
  //    也必须在摘归档标记**之前**：只要它还在 ctx.sessions 里，
  //    `listSessions()` 就会继续列出它。
  removed.liveEvicted = evictLiveSession(ctx, sessionId)
  if (removed.liveEvicted) await settlePersistence(ctx)

  // 2. 删日志目录 —— 真正销毁正文的一步。**任一目录删不掉就整体失败**，
  //    因为「部分删除」会留下仍能被列出来的会话。
  //    ⚠️ 目录来自 `indexSessionDirs()` 的真实扫描结果（bucket 下一级子目录名），
  //    且每个目录再经 `containedPath` 复核 —— 即使扫描结果被污染也无法越界。
  const resolvedDirs = dirs ?? await indexSessionDirs()
  const targets = resolvedDirs.get(sessionId) ?? []
  const sessionsRoot = path.join(dshHome(), 'sessions')
  for (const dir of targets) {
    const safe = containedPath(sessionsRoot, dir)
    if (safe === undefined) continue
    await removeTree(safe)
  }
  removed.logDirectory = targets.length > 0

  // 3. 删投影缓存；否则界面可能残留幽灵条目。
  //    越界路径（`undefined`）直接跳过 —— 那不是本插件该碰的文件。
  const cachePath = projectionCachePath(sessionId)
  if (cachePath !== undefined) {
    try {
      await fs.rm(cachePath, { force: true })
      removed.projectionCache = true
    } catch {
      // 缓存缺失或占用都不该让删除失败：它不是会话本体。
    }
  }

  // 4. 到这里数据已经真的没了，才摘归档标记。
  //    用服务而非直接改文档：服务负责原子写与事件广播，
  //    直接改 workspace.json 会绕过它的写队列，与其他写操作竞争。
  const registry = ctx.get('workspaceRegistry')
  if (detachArchiveMark && registry !== undefined && typeof registry.unarchiveSession === 'function') {
    await registry.unarchiveSession(sessionId)
    removed.archivedMark = true
  }

  // 5. 从工作区摘除归属（保留工作区本身）。失败不算致命。
  if (registry !== undefined && typeof registry.list === 'function') {
    for (const workspace of registry.list()) {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      if (!ids.includes(sessionId)) continue
      try {
        if (typeof workspace.detachSession === 'function') {
          await workspace.detachSession(sessionId)
          removed.workspaceDetached = true
        }
      } catch {
        // 单个工作区失败不影响删除本身。
      }
    }
  }

  return removed
}

/** 构造带 rpcId 的响应 JSON（与 DSH 网关契约一致）。 */
function reply(rpcId, result) {
  const value = typeof result === 'object' && result !== null && result.ok === false
    ? { ...result, error: { ...result.error, details: {} } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}

/** 统一的失败返回。 */
function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * 该会话此刻是否**正在跑一轮**。
 *
 * ⚠️ 判据必须是 `agent.status === 'running'`，**不是**「agent 是否存在」。
 * DSH 自己的判据同此（`dsh-api-session-controller` 的 `summaryFor`）。
 * 早期写成「存在即运行中」会让跑完的会话（agent 仍以 idle 挂着）永远删不掉
 * —— 这正是用户报障的那条。
 *
 * 读不到状态时返回 **false**（不阻断）：删除路径还有单写者句柄兜底，
 * 而误判成运行中会让用户完全无法清理。
 */
/**
 * 读一次 `sessionController.list()`，返回规范化后的摘要数组。
 *
 * ⚠️ **返回的是数组，不是 `{ items }` 包装** —— 源码
 * （`dsh-api-session-controller` 的 `list()`）末尾是 `return items`。
 * 早期两处调用都写成 `listed?.items ?? []`，于是恒为空 → 删除闸门退回
 * 「agent 存在即运行中」的旧判据 → **所有已完成会话都删不掉**（用户报障）。
 *
 * 抽成单一函数是刻意的：这个形状判断曾在两个地方各写一遍、也就错了两遍。
 * 只保留一个入口，改错只可能错一次。
 *
 * @returns 摘要数组；服务缺失或抛错时返回 `undefined`（调用方据此决定是否降级）。
 */
async function readSessionSummaries(ctx) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.list !== 'function') return undefined
  try {
    const listed = await controller.list(new AbortController().signal)
    if (Array.isArray(listed)) return listed
    // 兼容未来的 `{ items }` 形态：两种都认，避免上游改形后静默失效。
    if (Array.isArray(listed?.items)) return listed.items
    return []
  } catch {
    return undefined
  }
}

/**
 * 该会话此刻是否**正在跑一轮**。
 *
 * ⚠️ 判据必须是 `agent.status === 'running'`，**不是**「agent 是否存在」。
 * DSH 自己的判据同此（`dsh-api-session-controller` 的 `summaryFor`）。
 * 早期写成「存在即运行中」会让跑完的会话（agent 仍以 idle 挂着）永远删不掉。
 *
 * 读不到状态时返回 **false**（不阻断）：删除路径还有单写者句柄兜底，
 * 而误判成运行中会让用户完全无法清理。
 */
async function isSessionRunning(ctx, sessionId) {
  const summaries = await readSessionSummaries(ctx)
  if (summaries !== undefined) {
    for (const item of summaries) {
      if (item?.sessionId === sessionId) return item.running === true
    }
    // 权威列表里没有它 —— 不是活动会话，判定未运行，不再退回 agents。
    return false
  }
  const agents = ctx.get('agents')
  if (agents !== undefined && typeof agents.get === 'function') {
    try {
      return agents.get(sessionId)?.status === 'running'
    } catch {
      return false
    }
  }
  return false
}

/** 处理一个 RPC 调用。抽成独立函数便于单测直接驱动（不经 HTTP）。 */
export async function handleSessionArchiveRpc(ctx, method, payload) {
  const req = payload !== null && typeof payload === 'object' ? payload : {}

  switch (method) {
    case 'archive.list': {
      const { rows, summary } = await collectRows(ctx)
      return { ok: true, value: { rows, summary, home: dshHome() } }
    }

    case 'archive.restore': {
      const sessionId = req.sessionId
      if (!isPlausibleSessionId(sessionId)) return fail('bad-request', 'sessionId 缺失或形态非法')
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.unarchiveSession !== 'function') {
        return fail('unavailable', 'workspaceRegistry 服务不可用，无法恢复会话')
      }
      await registry.unarchiveSession(sessionId)
      ctx.logger?.info?.(`[session-archive] 已恢复会话 ${sessionId}`)
      return { ok: true, value: { sessionId, restored: true } }
    }

    case 'archive.restoreMany': {
      const ids = Array.isArray(req.sessionIds) ? req.sessionIds : []
      if (ids.length === 0) return fail('bad-request', 'sessionIds 不能为空')
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.unarchiveSession !== 'function') {
        return fail('unavailable', 'workspaceRegistry 服务不可用，无法恢复会话')
      }
      const restored = []
      const failed = []
      for (const id of ids) {
        if (!isPlausibleSessionId(id)) {
          failed.push({ sessionId: String(id), reason: '会话 id 形态非法' })
          continue
        }
        try {
          await registry.unarchiveSession(id)
          restored.push(id)
        } catch (error) {
          failed.push({ sessionId: id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      ctx.logger?.info?.(`[session-archive] 批量恢复 ${restored.length} 个会话，失败 ${failed.length} 个`)
      return { ok: true, value: { restored, failed } }
    }

    case 'archive.delete': {
      const sessionId = req.sessionId
      if (!isPlausibleSessionId(sessionId)) return fail('bad-request', 'sessionId 缺失或形态非法')

      // ⚠️ 只允许删除**当前确实已归档**的会话。这是安全边界，不是 UI 提示。
      const archived = await readArchivedIds()
      if (!archived.has(sessionId)) {
        return fail('bad-request', '该会话不在归档集合中，拒绝删除')
      }

      // 正在运行的会话不可删除（见文件头注释第 4 条）。
      // ⚠️ 判据是 `running`，不是「agent 是否存在」（见 isSessionRunning）。
      if (await isSessionRunning(ctx, sessionId)) {
        return fail('bad-request', '会话正在运行，请先停止后再删除')
      }

      // ⚠️ 删除失败必须返回**失败**，且此时归档标记必须原样保留。
      // 只有这样用户看到的才是「没删掉、可重试」，而不是「删了、但它跑回
      // 未归档列表里了」——后者正是本次修复的故障形态（见 deleteSession 注释）。
      let removed
      try {
        removed = await deleteSession(ctx, sessionId)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger?.error?.(`[session-archive] 删除归档会话 ${sessionId} 失败（会话仍保持归档，可重试）：${reason}`)
        return fail('delete-failed', `删除失败，会话仍保持归档，可重试：${reason}`)
      }
      const subagentCount = removed.subagents?.deleted?.length ?? 0
      ctx.logger?.warn?.(
        `[session-archive] 已永久删除归档会话 ${sessionId}（日志目录=${removed.logDirectory}`
        + `，级联删除子代理会话 ${subagentCount} 个）`,
      )
      return { ok: true, value: { sessionId, removed } }
    }

    case 'archive.deleteMany': {
      const ids = Array.isArray(req.sessionIds) ? req.sessionIds : []
      if (ids.length === 0) return fail('bad-request', 'sessionIds 不能为空')
      const archived = await readArchivedIds()
      const deleted = []
      const failed = []
      for (const id of ids) {
        if (!isPlausibleSessionId(id)) {
          failed.push({ sessionId: String(id), reason: '会话 id 形态非法' })
          continue
        }
        if (!archived.has(id)) {
          failed.push({ sessionId: id, reason: '该会话不在归档集合中，拒绝删除' })
          continue
        }
        // ⚠️ 与单条删除同一判据（`running`，非「存在」）。
        if (await isSessionRunning(ctx, id)) {
          failed.push({ sessionId: id, reason: '会话正在运行，请先停止后再删除' })
          continue
        }
        try {
          const removed = await deleteSession(ctx, id)
          deleted.push({ sessionId: id, removed })
        } catch (error) {
          failed.push({ sessionId: id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      ctx.logger?.warn?.(`[session-archive] 批量删除 ${deleted.length} 个会话，失败 ${failed.length} 个`)
      return { ok: true, value: { deleted, failed } }
    }

    default:
      return fail('bad-request', `unknown method: ${String(method)}`)
  }
}

/**
 * 注册 HTTP RPC 端点。
 *
 * `ctx.inject(['connection'], ...)` 而非静态 inject：见 `inject` 的注释。
 * 拿不到 connection（headless / CLI profile）时静默跳过 —— 插件服务本身仍可用。
 */
function registerEndpoints(ctx) {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection ?? connectionCtx.get?.('connection')
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      ctx.logger?.warn?.('[session-archive] connection.fetch 不可用，RPC 端点未注册')
      return
    }

    connection.fetch.register({
      path: SESSION_ARCHIVE_API_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }

        let message
        try {
          message = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }

        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
        const call = message?.payload
        if (
          message?.type !== 'client-request'
          || typeof message.rpcId !== 'string'
          || message.method !== SESSION_ARCHIVE_ENDPOINT
          || call === null || typeof call !== 'object'
          || typeof call.method !== 'string'
          || !Object.prototype.hasOwnProperty.call(call, 'payload')
        ) {
          return reply(rpcId, fail('gateway/bad-request', 'Invalid session-archive request.'))
        }

        try {
          return reply(rpcId, await handleSessionArchiveRpc(ctx, call.method, call.payload))
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          ctx.logger?.error?.(`[session-archive] ${call.method} 失败：${reason}`)
          return reply(rpcId, fail('internal', reason))
        }
      },
    })
  })
}

/** 插件入口。 */
export function apply(ctx) {
  registerEndpoints(ctx)
  ctx.logger?.info?.(
    `[session-archive] 归档会话管理已就绪（DSH_HOME=${dshHome()}）`,
  )
}

/**
 * 纯函数层：不接触 ctx、不接触文件系统，便于单测锁死行为。
 *
 * 归档会话管理的核心判据都放在这里 —— 排序、检索、可删除性判定。
 * 宿主侧（lib/index.js）只负责取数与落盘，判定一律走本模块。
 */

/** 会话 id 的形态：`session-<uuid>`；旧格式是没有前缀的裸 uuid。 */
const SESSION_ID_PATTERN = /^(?:session-)?[0-9a-fA-F-]{36}$/

/**
 * 归一化会话 id。
 *
 * ⚠️ 刻意**不补齐** `session-` 前缀：DSH 里两种形态都真实存在
 * （`storages/session_projcache/sessions/` 下同时有裸 uuid 与 `session-` 前缀文件），
 * 补前缀会让「按 id 找日志目录」在裸 uuid 场景下失配。这里只做去空白与长度校验。
 */
export function normalizeSessionId(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  return trimmed
}

/**
 * 是否为**看起来合法**的会话 id —— 用于 **RPC 入口**的强校验。
 *
 * ⚠️ 这是**形态**校验（`session-<uuid>` / 裸 uuid），刻意比「路径安全」更严：
 * 入口处收到的 id 完全来自外部（可被伪造），所以只放行已知形态。
 *
 * ⚠️ **不要**用它校验「磁盘上发现的会话 id」—— 真实数据里存在
 * `fusion-worker-<uuid>` 这类**不属于会话 uuid 形态**的会话目录
 * （智能体团队的 worker 会话）。用形态校验会把它们判为非法，
 * 于是级联删除**静默漏掉**这些子代理，又变回「子代理留下来」的故障。
 * 那种场景请用 `isSafePathSegment`。
 */
export function isPlausibleSessionId(value) {
  const id = normalizeSessionId(value)
  if (id === undefined) return false
  // 必须匹配固定形态，且不得含路径分隔符或 `..`（删除会拼进路径）。
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  return SESSION_ID_PATTERN.test(id)
}

/**
 * 是否为**可以安全拼进文件路径**的单个路径片段。
 *
 * 用于校验**磁盘上发现的**会话 id（目录名 / 日志头里的 id）。判据只关心
 * 「拼进路径后不会逃出基目录」，**不限制具体形态** —— 这样
 * `fusion-worker-<uuid>` 这类真实存在的会话目录也能被正常删除。
 *
 * 拒绝：空串、`.`、`..`、含路径分隔符、含 Windows 盘符/ADS 的 `:`、
 * 含控制字符或 NUL、超长（>200）。
 */
export function isSafePathSegment(value) {
  const id = normalizeSessionId(value)
  if (id === undefined) return false
  if (id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\')) return false
  if (id.includes(':')) return false
  // 控制字符（含 NUL）会让路径解析产生意外行为。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return false
  // 超长名在多数文件系统上本就非法；留出 `.json` 等后缀余量。
  if (id.length > 200) return false
  return true
}

/** 大小写不敏感的子串匹配。 */
function contains(haystack, needle) {
  if (typeof haystack !== 'string' || haystack.length === 0) return false
  return haystack.toLowerCase().includes(needle)
}

/**
 * 元数据检索：标题 / 工作目录 / 所属工作区 / 会话 id。
 *
 * 空查询视为「全匹配」，这样调用方不必分两条路径。
 */
export function matchesQuery(row, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle.length === 0) return true
  if (row === undefined || row === null) return false
  return (
    contains(row.title, needle)
    || contains(row.cwd, needle)
    || contains(row.workspaceTitle, needle)
    || contains(row.sessionId, needle)
  )
}

/** 按元数据查询过滤一组行。 */
export function filterRows(rows, query) {
  if (!Array.isArray(rows)) return []
  return rows.filter((row) => matchesQuery(row, query))
}

/**
 * 排序：最近活动在前。
 *
 * 判据优先用 `updatedAt`（标题事件时间，代表「最后一次有内容」），
 * 缺失时退回 `createdAt`。两者都缺的排到最后 —— 不按 id 排，
 * 那会让「刚归档的会话」随机分布，用户找不到。
 */
export function sortRows(rows) {
  if (!Array.isArray(rows)) return []
  return [...rows].sort((a, b) => {
    const ta = activityTime(a)
    const tb = activityTime(b)
    if (ta !== tb) return tb - ta
    return String(a?.sessionId ?? '').localeCompare(String(b?.sessionId ?? ''))
  })
}

function activityTime(row) {
  const updated = Number(row?.updatedAt)
  if (Number.isFinite(updated) && updated > 0) return updated
  const created = Number(row?.createdAt)
  if (Number.isFinite(created) && created > 0) return created
  return 0
}

/**
 * 可删除性判定。
 *
 * 返回 `undefined` 表示允许删除，否则返回**给用户看的中文原因**。
 *
 * ⚠️ **判据是 `running`（正在跑一轮），不是 `live`（有活动 agent）**。
 *
 * 这两者极易混淆，且混淆的代价已经真实发生过：会话跑完后 agent 仍以
 * **idle** 状态挂在注册表里，`agents.get(id) !== undefined` 因此恒为真，
 * 于是**所有已完成会话都被误报成「运行中」、无法删除**（用户报障）。
 * `live` 只作为「这个会话当前是否被打开」的信息展示，不参与删除判定。
 *
 * 只有真正 `running` 才硬阻断：删除是不可逆的，且正在写的日志被移除后
 * 下一次 append 会失败，用户会看到会话无故损坏。
 */
export function deletableIssue(row) {
  if (row === undefined || row === null) return '会话不存在'
  if (!isPlausibleSessionId(row.sessionId)) return '会话 id 形态非法，拒绝删除'
  if (row.running === true) return '会话正在运行，请先停止后再删除'
  if (row.archived !== true) return '会话未处于归档状态'
  return undefined
}

/**
 * 从选中行里分出「可删除」与「被跳过」两组。
 *
 * 存在的意义是让**上方批量按钮与右侧单条按钮用同一判据**：早期批量按钮
 * 只判「有没有选中」，于是右侧删除按钮已置灰（判为运行中）时，上方
 * 「删除选中」却仍可按 —— 用户点下去才发现被跳过（用户报障）。
 */
export function partitionDeletable(rows) {
  const deletable = []
  const skipped = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const issue = deletableIssue(row)
    if (issue === undefined) deletable.push(row)
    else skipped.push({ sessionId: row?.sessionId ?? '', reason: issue })
  }
  return { deletable, skipped }
}

/**
 * 从会话头里判断它是不是 `parentId` 的**子代理会话**。
 *
 * ⚠️ 判据必须是 `origin === 'subagent'` **且** `parentSession === parentId`，
 * 两者缺一不可：
 *
 * - 只看 `parentSession` 会把 **fork（分叉）** 也算进来。fork 同样带
 *   `parentSession`，但它是**独立会话** —— 用户分叉出来就是要接着聊的，
 *   删掉原会话不该连带删掉它。
 * - 只看 `origin === 'subagent'` 则无法确定父是谁。
 *
 * 这正是 DSH 自己的判据：`dsh-session-persistence-jsonl` 的
 * `prepareStoredMigration` 里就是
 * `source.header.origin === 'subagent' && source.header.parentSession === id`。
 */
export function isSubagentOf(header, parentId) {
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin !== 'subagent') return false
  return header.parentSession === parentId
}

/**
 * 从一组会话头里，递归收集 `rootId` 的**全部子代理后代**（不含 root 自己）。
 *
 * 返回**由深到浅**的顺序：先子代理的孙辈、再子代理本身。删除必须按这个顺序
 * 执行 —— 先删叶子再删父，否则中途失败会留下「父已删、子成孤儿」的状态，
 * 而孤儿子代理再也没法通过父会话被找到（用户会看到它们永久留在列表里）。
 *
 * 用迭代 + 显式栈而非递归：血缘可能很深（团队套团队），递归会爆栈。
 * 同时用 `visited` 防环 —— 损坏的日志可能写出互相引用的 `parentSession`，
 * 没有防护就是死循环。
 *
 * ⚠️ **每个后代 id 都必须通过 `isSafePathSegment` 才收进结果**。
 * 这些 id 来自**磁盘上的会话头**，不是用户输入 —— 头文件可能被外部工具改写、
 * 被旧版本写坏，因此必须当成不可信输入。调用方会用这些 id 去拼文件路径
 * （`sessions/<bucket>/<id>/`、`session_projcache/sessions/<id>.json`），
 * 放行 `../` 就等于「删掉任意文件」。这是实测确认过的真实漏洞，不是理论风险。
 *
 * ⚠️ 这里用**路径安全**校验（`isSafePathSegment`）而**不是**形态校验
 * （`isPlausibleSessionId`）：真实数据里有 `fusion-worker-<uuid>` 这类
 * 非 uuid 形态的会话目录，用形态校验会把它们漏掉，导致子代理删不干净。
 *
 * @param headers - 可迭代的会话头（每项需有 `id` / `parentSession` / `origin`）。
 * @param rootId - 起点会话 id。
 * @returns 子代理后代 id 列表，深的在前；无后代时返回 `[]`。
 */
export function collectSubagentDescendants(headers, rootId) {
  const list = Array.isArray(headers) ? headers : [...(headers ?? [])]
  const childrenOf = new Map()
  for (const header of list) {
    if (header === null || typeof header !== 'object') continue
    // ⚠️ 只有 subagent 才算血缘；fork 不进这棵树。
    if (header.origin !== 'subagent') continue
    // ⚠️ 路径安全校验：id 会被拼进文件路径，绝不能让 `../` 或绝对路径进来。
    const id = normalizeSessionId(header.id)
    if (id === undefined || !isSafePathSegment(id)) continue
    const parent = normalizeSessionId(header.parentSession)
    if (parent === undefined) continue
    const bucket = childrenOf.get(parent)
    if (bucket === undefined) childrenOf.set(parent, [id])
    else bucket.push(id)
  }

  const root = normalizeSessionId(rootId)
  if (root === undefined) return []

  // 显式栈的后序遍历：每个节点都在其全部后代**之后**出栈，
  // 于是 postOrder 天然是「深 → 浅」，root 固定排在最后。
  const visited = new Set()
  const postOrder = []
  const stack = [{ id: root, expanded: false }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.expanded) {
      postOrder.push(frame.id)
      continue
    }
    if (visited.has(frame.id)) continue
    visited.add(frame.id)
    // 先压「已展开」帧，再压子节点 —— 子节点会先出栈，从而排在本节点之前。
    stack.push({ id: frame.id, expanded: true })
    for (const child of childrenOf.get(frame.id) ?? []) {
      if (!visited.has(child)) stack.push({ id: child, expanded: false })
    }
  }

  const ordered = []
  for (const id of postOrder) if (id !== root) ordered.push(id)
  return ordered
}

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** 汇总行集合：条数与总占用。 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : []
  let totalBytes = 0
  for (const row of list) {
    const n = Number(row?.sizeBytes)
    if (Number.isFinite(n) && n > 0) totalBytes += n
  }
  return { count: list.length, totalBytes }
}

/**
 * 把工作区路径映射成展示名。
 *
 * 判据用**路径**而非 sessionId：同一个会话可能出现在多个工作区条目里
 * （`insertSessionBefore` 会移动归属），而路径是稳定且唯一的。
 * 比较时大小写不敏感 —— Windows 路径大小写不敏感，`E:\AM` 与 `e:\am`
 * 指向同一目录，严格比较会漏匹配。
 */
export function buildWorkspaceIndex(workspaces) {
  const byPath = new Map()
  const bySession = new Map()
  for (const ws of Array.isArray(workspaces) ? workspaces : []) {
    if (ws === null || typeof ws !== 'object') continue
    const path = typeof ws.path === 'string' ? ws.path.toLowerCase() : undefined
    const title = typeof ws.title === 'string' && ws.title.length > 0 ? ws.title : undefined
    if (path !== undefined && title !== undefined) byPath.set(path, title)
    const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
    for (const id of ids) {
      if (typeof id === 'string' && title !== undefined) bySession.set(id, title)
    }
  }
  return { byPath, bySession }
}

/** 按 cwd 解析工作区展示名；解析不到时返回 undefined（界面显示 cwd 本身）。 */
export function workspaceTitleFor(index, cwd, sessionId) {
  if (index === undefined || index === null) return undefined
  if (typeof sessionId === 'string' && index.bySession?.has(sessionId)) {
    return index.bySession.get(sessionId)
  }
  if (typeof cwd === 'string' && index.byPath?.has(cwd.toLowerCase())) {
    return index.byPath.get(cwd.toLowerCase())
  }
  return undefined
}

/** 组装最终返回给界面的行：排序 + 派生展示字段。 */
export function buildRows(input) {
  const rows = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (raw === null || typeof raw !== 'object') continue
    const sessionId = normalizeSessionId(raw.sessionId)
    if (sessionId === undefined) continue
    rows.push({
      sessionId,
      title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : '(无标题)',
      titleSource: raw.titleSource ?? 'unknown',
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
      workspaceTitle: raw.workspaceTitle ?? '',
      createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : 0,
      updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
      sizeBytes: Number.isFinite(Number(raw.sizeBytes)) ? Number(raw.sizeBytes) : 0,
      eventCount: Number.isFinite(Number(raw.eventCount)) ? Number(raw.eventCount) : 0,
      live: raw.live === true,
      // `running` 与 `live` **必须分开**：前者是「正在跑一轮」（删除的硬阻断判据），
      // 后者只是「有活动 agent 注册」（跑完后仍为真）。合并会让已完成会话
      // 全部被误判成运行中。缺省一律 false —— 这个字段决定能否删除，不能臆造。
      running: raw.running === true,
      persisted: raw.persisted === true,
      archived: raw.archived === true,
      exists: raw.exists === true,
    })
  }
  return sortRows(rows)
}

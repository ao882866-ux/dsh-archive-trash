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

/** 是否为看起来合法的会话 id（用于删除前的强校验，防止路径穿越）。 */
export function isPlausibleSessionId(value) {
  const id = normalizeSessionId(value)
  if (id === undefined) return false
  // 必须匹配固定形态，且不得含路径分隔符或 `..`（删除会拼进路径）。
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  return SESSION_ID_PATTERN.test(id)
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

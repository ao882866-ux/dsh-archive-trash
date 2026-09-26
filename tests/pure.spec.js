/**
 * 纯函数层的回归用例。
 *
 * 重点锁死三处**安全相关**的判定，它们被绕过就等于插件形同虚设：
 * 1. `isPlausibleSessionId` 必须拒绝路径穿越（id 会被拼进文件路径）；
 * 2. `deletableIssue` 必须拒绝运行中的会话（会损坏写路径）；
 * 3. `buildRows` 的排序必须是「最近活动在前」，否则用户找不到刚归档的会话。
 */

import { describe, expect, it } from 'vitest'
import {
  buildRows,
  buildWorkspaceIndex,
  deletableIssue,
  filterRows,
  formatBytes,
  isPlausibleSessionId,
  matchesQuery,
  normalizeSessionId,
  partitionDeletable,
  sortRows,
  summarize,
  workspaceTitleFor,
} from '../lib/pure.js'

const A = 'session-11111111-1111-1111-1111-111111111111'
const B = 'session-22222222-2222-2222-2222-222222222222'
const C = 'session-33333333-3333-3333-3333-333333333333'

describe('isPlausibleSessionId', () => {
  it('接受两种真实存在的形态：带 session- 前缀与裸 uuid', () => {
    // 裸 uuid 真实存在于 storages/session_projcache/sessions/ 下，必须放行。
    expect(isPlausibleSessionId(A)).toBe(true)
    expect(isPlausibleSessionId('11111111-1111-1111-1111-111111111111')).toBe(true)
  })

  it('拒绝路径穿越与分隔符 —— 这是删除路径拼接的安全边界', () => {
    expect(isPlausibleSessionId('../../etc/passwd')).toBe(false)
    expect(isPlausibleSessionId('session-11111111-1111-1111-1111-111111111111/../x')).toBe(false)
    expect(isPlausibleSessionId('..\\..\\windows\\system32')).toBe(false)
    expect(isPlausibleSessionId('session-11111111-1111-1111-1111-111111111111\\evil')).toBe(false)
  })

  it('拒绝空值、非字符串与长度不足的 id', () => {
    expect(isPlausibleSessionId(undefined)).toBe(false)
    expect(isPlausibleSessionId(null)).toBe(false)
    expect(isPlausibleSessionId(42)).toBe(false)
    expect(isPlausibleSessionId('')).toBe(false)
    expect(isPlausibleSessionId('   ')).toBe(false)
    expect(isPlausibleSessionId('session-abc')).toBe(false)
  })

  it('normalizeSessionId 不补齐前缀（补了会让裸 uuid 的目录查找失配）', () => {
    expect(normalizeSessionId('11111111-1111-1111-1111-111111111111'))
      .toBe('11111111-1111-1111-1111-111111111111')
    expect(normalizeSessionId(`  ${A}  `)).toBe(A)
  })
})

describe('deletableIssue', () => {
  const base = { sessionId: A, running: false, archived: true }

  it('归档且未运行时可删除', () => {
    expect(deletableIssue(base)).toBeUndefined()
  })

  it('真正在跑的会话拒绝删除（抽走日志会让写路径损坏）', () => {
    expect(deletableIssue({ ...base, running: true })).toContain('正在运行')
  })

  it('⚠️ 回归：跑完的会话（live=true, running=false）必须可删除', () => {
    // 真实缺陷：会话跑完后 agent 仍以 idle 挂在注册表里，`live` 恒为真。
    // 早期用 `live` 当运行判据 → 所有已完成会话都被误报「运行中」、无法删除。
    expect(deletableIssue({ ...base, live: true, running: false })).toBeUndefined()
  })

  it('`live` 单独存在不得阻断删除（判据只认 running）', () => {
    expect(deletableIssue({ ...base, live: true })).toBeUndefined()
    expect(deletableIssue({ ...base, running: false, live: true })).toBeUndefined()
  })

  it('未归档的会话拒绝删除 —— 防止伪造请求删任意会话', () => {
    expect(deletableIssue({ ...base, archived: false })).toContain('未处于归档状态')
  })

  it('id 形态非法时拒绝删除', () => {
    expect(deletableIssue({ ...base, sessionId: '../../evil' })).toContain('非法')
  })

  it('空行拒绝删除', () => {
    expect(deletableIssue(undefined)).toBe('会话不存在')
  })
})

describe('partitionDeletable', () => {
  it('分出可删除与被跳过两组，并带上原因', () => {
    const rows = [
      { sessionId: A, running: false, archived: true },
      { sessionId: B, running: true, archived: true },
      { sessionId: C, running: false, archived: false },
    ]
    const { deletable, skipped } = partitionDeletable(rows)
    expect(deletable.map((r) => r.sessionId)).toEqual([A])
    expect(skipped.map((s) => s.sessionId)).toEqual([B, C])
    expect(skipped[0].reason).toContain('正在运行')
    expect(skipped[1].reason).toContain('未处于归档状态')
  })

  it('非数组输入返回两个空数组', () => {
    expect(partitionDeletable(undefined)).toEqual({ deletable: [], skipped: [] })
  })

  it('全部可删除时 skipped 为空', () => {
    const rows = [{ sessionId: A, running: false, archived: true }]
    const { deletable, skipped } = partitionDeletable(rows)
    expect(deletable).toHaveLength(1)
    expect(skipped).toEqual([])
  })
})

describe('sortRows', () => {
  it('最近活动在前，且优先用 updatedAt', () => {
    const rows = [
      { sessionId: A, updatedAt: 100, createdAt: 999 },
      { sessionId: B, updatedAt: 300, createdAt: 1 },
      { sessionId: C, updatedAt: 200, createdAt: 5 },
    ]
    expect(sortRows(rows).map((r) => r.sessionId)).toEqual([B, C, A])
  })

  it('updatedAt 缺失时退回 createdAt', () => {
    const rows = [
      { sessionId: A, updatedAt: 0, createdAt: 500 },
      { sessionId: B, updatedAt: 0, createdAt: 100 },
    ]
    expect(sortRows(rows).map((r) => r.sessionId)).toEqual([A, B])
  })

  it('两者都缺的排到最后（而不是按 id 随机分布）', () => {
    const rows = [
      { sessionId: A, updatedAt: 0, createdAt: 0 },
      { sessionId: B, updatedAt: 10, createdAt: 10 },
    ]
    expect(sortRows(rows).map((r) => r.sessionId)).toEqual([B, A])
  })

  it('不修改入参', () => {
    const rows = [{ sessionId: A, updatedAt: 1 }, { sessionId: B, updatedAt: 2 }]
    const copy = [...rows]
    sortRows(rows)
    expect(rows).toEqual(copy)
  })
})

describe('matchesQuery / filterRows', () => {
  const row = {
    sessionId: A,
    title: '修复 PlatformIO 编译',
    cwd: 'C:\\Users\\gaole\\Desktop\\DualEQ',
    workspaceTitle: 'DualEQ',
  }

  it('空查询匹配一切', () => {
    expect(matchesQuery(row, '')).toBe(true)
    expect(matchesQuery(row, '   ')).toBe(true)
  })

  it('大小写不敏感地匹配标题 / 路径 / 工作区 / id', () => {
    expect(matchesQuery(row, 'platformio')).toBe(true)
    expect(matchesQuery(row, 'dualeq')).toBe(true)
    expect(matchesQuery(row, 'desktop')).toBe(true)
    expect(matchesQuery(row, A.slice(8, 16))).toBe(true)
  })

  it('不匹配时返回 false', () => {
    expect(matchesQuery(row, 'zzz-not-there')).toBe(false)
  })

  it('filterRows 对非数组输入返回空数组', () => {
    expect(filterRows(undefined, 'x')).toEqual([])
    expect(filterRows(null, 'x')).toEqual([])
  })
})

describe('buildWorkspaceIndex / workspaceTitleFor', () => {
  it('按路径解析工作区标题，且大小写不敏感', () => {
    const index = buildWorkspaceIndex([{ path: 'E:\\AM', title: 'AM', sessionIds: [A] }])
    expect(workspaceTitleFor(index, 'e:\\am', undefined)).toBe('AM')
    expect(workspaceTitleFor(index, 'E:\\AM', undefined)).toBe('AM')
  })

  it('优先按 sessionId 归属解析（会话可能被移动到别的工作区）', () => {
    const index = buildWorkspaceIndex([
      { path: 'E:\\AM', title: 'AM', sessionIds: [] },
      { path: 'E:\\other', title: 'Other', sessionIds: [A] },
    ])
    // cwd 仍指向 AM，但归属已被移动到 Other —— 以归属为准。
    expect(workspaceTitleFor(index, 'E:\\AM', A)).toBe('Other')
  })

  it('解析不到时返回 undefined（界面回退显示 cwd）', () => {
    const index = buildWorkspaceIndex([])
    expect(workspaceTitleFor(index, 'E:\\AM', A)).toBeUndefined()
    expect(workspaceTitleFor(undefined, 'E:\\AM', A)).toBeUndefined()
  })
})

describe('buildRows', () => {
  it('丢弃没有合法 id 的行，并为缺失字段填默认值', () => {
    const rows = buildRows([
      { sessionId: A, title: 'ok', archived: true },
      { sessionId: '', title: 'drop' },
      { title: 'drop-no-id' },
      null,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sessionId: A,
      title: 'ok',
      cwd: '',
      workspaceTitle: '',
      sizeBytes: 0,
      eventCount: 0,
      archived: true,
      exists: false,
    })
  })

  it('archived / exists / live / running 是**入参**字段，缺省一律为 false（不臆造状态）', () => {
    // 这四个字段决定「能不能删」，绝不能在组装阶段被默认成 true。
    const rows = buildRows([{ sessionId: A }])
    expect(rows[0].archived).toBe(false)
    expect(rows[0].exists).toBe(false)
    expect(rows[0].live).toBe(false)
    expect(rows[0].running).toBe(false)
  })

  it('⚠️ 回归：live 与 running 必须各自独立传递，不得合并', () => {
    // 合并会让「跑完但 agent 还在」的会话被判成运行中而无法删除。
    const rows = buildRows([{ sessionId: A, live: true, running: false, archived: true }])
    expect(rows[0].live).toBe(true)
    expect(rows[0].running).toBe(false)
    expect(deletableIssue(rows[0])).toBeUndefined()
  })

  it('标题为空时回退为 (无标题)，而不是空字符串', () => {
    const rows = buildRows([{ sessionId: A, title: '' }])
    expect(rows[0].title).toBe('(无标题)')
  })

  it('非数字字段被归一化为 0（避免界面出现 NaN）', () => {
    const rows = buildRows([{ sessionId: A, sizeBytes: 'abc', eventCount: null, createdAt: {} }])
    expect(rows[0].sizeBytes).toBe(0)
    expect(rows[0].eventCount).toBe(0)
    expect(rows[0].createdAt).toBe(0)
  })
})

describe('summarize / formatBytes', () => {
  it('累加有效字节数，忽略非法值', () => {
    expect(summarize([{ sizeBytes: 100 }, { sizeBytes: 200 }, { sizeBytes: -5 }, {}]))
      .toEqual({ count: 4, totalBytes: 300 })
  })

  it('非数组输入返回零值', () => {
    expect(summarize(undefined)).toEqual({ count: 0, totalBytes: 0 })
  })

  it('格式化人类可读字节数', () => {
    expect(formatBytes(0)).toBe('—')
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
  })
})

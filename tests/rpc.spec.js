/**
 * 宿主侧 RPC 处理器的回归用例。
 *
 * 每个用例都在**一次性临时 DSH_HOME** 下运行（`DSH_HOME` 环境变量指向它），
 * 绝不触碰真实的 `~/.dsh` —— 删除用例是真的 `fs.rm`，污染真实目录代价极高。
 *
 * 重点覆盖**安全边界**：伪造的 `archive.delete` 请求不能删掉未归档的会话，
 * 路径穿越 id 不能逃出 sessions 目录。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const A = 'session-11111111-1111-1111-1111-111111111111'
const B = 'session-22222222-2222-2222-2222-222222222222'
const C = 'session-33333333-3333-3333-3333-333333333333'

import { handleSessionArchiveRpc } from '../lib/index.js'

let home
let unarchived
let detached
let logger

/** 极简 ctx 替身：只实现被测代码实际读到的服务。 */
function makeCtx(overrides = {}) {
  const services = new Map(Object.entries(overrides))
  return {
    get: (key) => services.get(key),
    logger: logger ?? { info() {}, warn() {}, error() {} },
  }
}

function makeRegistry() {
  unarchived = []
  detached = []
  return {
    unarchiveSession: async (id) => { unarchived.push(id) },
    list: () => [{
      sessionIds: [A, C],
      detachSession: async (id) => { detached.push(id) },
    }],
  }
}

/** 建一个最小但形状正确的 DSH_HOME。 */
async function seedHome({ archived = [A], workspaces = [], persistence } = {}) {
  await mkdir(path.join(home, 'storages'), { recursive: true })
  await mkdir(path.join(home, 'sessions', '--E-AM--', A), { recursive: true })
  await mkdir(path.join(home, 'sessions', '--E-AM--', C), { recursive: true })
  await writeFile(path.join(home, 'sessions', '--E-AM--', A, 'session.v4.jsonl.zstd'), 'log-a')
  await writeFile(path.join(home, 'sessions', '--E-AM--', C, 'session.v4.jsonl.zstd'), 'log-c')

  await writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: archived, pinnedSessionIds: [] },
    tables: {
      workspaces: workspaces.length === 0
        ? {}
        : Object.fromEntries(workspaces.map((ws, i) => [`ws-${i}`, ws])),
    },
  }))

  await mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(
    path.join(home, 'storages', 'session_projcache', 'sessions', `${A}.json`),
    JSON.stringify({ version: 7, record: { rows: { title: { val: '缓存的标题' } } } }),
  )

  return persistence
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'dsh-archive-test-'))
  // 模块在**调用时**才读 DSH_HOME（`dshHome()` 是函数而非顶层常量），
  // 故这里设置环境变量即可，无需重新导入模块。
  process.env.DSH_HOME = home
  logger = { info() {}, warn() {}, error() {} }
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('archive.list', () => {
  it('只返回归档集合里的会话，并带上工作区与标题', async () => {
    await seedHome({
      archived: [A, C],
      workspaces: [{ path: 'E:\\AM', title: 'AM', sessionIds: [A, C] }],
    })
    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})

    expect(result.ok).toBe(true)
    const ids = result.value.rows.map((row) => row.sessionId).sort()
    expect(ids).toEqual([A, C].sort())
    const rowA = result.value.rows.find((row) => row.sessionId === A)
    expect(rowA.workspaceTitle).toBe('AM')
    expect(rowA.title).toBe('缓存的标题')
    expect(rowA.archived).toBe(true)
    expect(rowA.exists).toBe(true)
    expect(rowA.sizeBytes).toBeGreaterThan(0)
    expect(result.value.summary.count).toBe(2)
  })

  it('归档集合为空时返回空列表而不是报错', async () => {
    await seedHome({ archived: [] })
    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
    expect(result.ok).toBe(true)
    expect(result.value.rows).toEqual([])
    expect(result.value.summary).toEqual({ count: 0, totalBytes: 0 })
  })

  it('workspace.json 缺失时优雅降级为空列表（不抛错）', async () => {
    // 刻意不 seed：整个 DSH_HOME 是空的。
    const ctx = makeCtx({})
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
    expect(result.ok).toBe(true)
    expect(result.value.rows).toEqual([])
  })

  it('sessionQuery 可用时优先用它的标题（权威，能反映未落盘的改名）', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionQuery: {
        readTitleSnapshots: async (ids) => ids.map((sessionId) => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: '权威标题', source: { kind: 'user' } } },
        })),
      },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
    const rowA = result.value.rows.find((row) => row.sessionId === A)
    expect(rowA.title).toBe('权威标题')
    expect(rowA.titleSource).toBe('user')
  })

  it('sessionQuery 抛错时回退到投影缓存（不能让整页失败）', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionQuery: { readTitleSnapshots: async () => { throw new Error('boom') } },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
    expect(result.ok).toBe(true)
    expect(result.value.rows.find((row) => row.sessionId === A).title).toBe('缓存的标题')
  })
})

describe('archive.restore', () => {
  it('调用 workspaceRegistry.unarchiveSession', async () => {
    await seedHome({ archived: [A] })
    const registry = makeRegistry()
    const ctx = makeCtx({ workspaceRegistry: registry })
    const result = await handleSessionArchiveRpc(ctx, 'archive.restore', { sessionId: A })
    expect(result.ok).toBe(true)
    expect(unarchived).toEqual([A])
  })

  it('id 形态非法时拒绝，且不调用服务', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.restore', { sessionId: '../../evil' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('bad-request')
    expect(unarchived).toEqual([])
  })

  it('服务缺失时明确报 unavailable，而不是静默成功', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({})
    const result = await handleSessionArchiveRpc(ctx, 'archive.restore', { sessionId: A })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('unavailable')
  })

  it('批量恢复逐条返回成功与失败，单条失败不中断整体', async () => {
    await seedHome({ archived: [A, B] })
    const registry = makeRegistry()
    // 让第二个 id 失败，验证其余仍然恢复。
    const original = registry.unarchiveSession
    registry.unarchiveSession = async (id) => {
      if (id === B) throw new Error('nope')
      return original(id)
    }
    const ctx = makeCtx({ workspaceRegistry: registry })
    const result = await handleSessionArchiveRpc(ctx, 'archive.restoreMany', { sessionIds: [A, B, '../../x'] })
    expect(result.ok).toBe(true)
    expect(result.value.restored).toEqual([A])
    expect(result.value.failed).toHaveLength(2)
    expect(result.value.failed.map((f) => f.sessionId)).toEqual([B, '../../x'])
  })
})

describe('archive.delete —— 安全边界', () => {
  it('删除归档会话：**永久**移除日志目录与投影缓存，并先摘归档标记', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })

    expect(result.ok).toBe(true)
    expect(result.value.removed).toMatchObject({
      archivedMark: true,
      logDirectory: true,
      projectionCache: true,
    })
    // ⚠️ 永久删除：原位置与回收站都**不该**留下任何副本。
    // 用户明确要求「确认删除后直接完全删除」，故这里断言真的消失。
    expect(existsSync(path.join(home, 'sessions', '--E-AM--', A))).toBe(false)
    expect(existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${A}.json`))).toBe(false)
    // 不得再有任何回收站目录残留。
    expect(existsSync(path.join(home, 'session-archive-trash'))).toBe(false)
    // 先摘归档标记（失败方向可恢复）。
    expect(unarchived).toEqual([A])
    // 从工作区摘除归属。
    expect(detached).toEqual([A])
  })

  it('拒绝删除**未归档**的会话 —— 伪造请求不能删任意会话', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    // C 存在于磁盘、且在工作区里，但**不在**归档集合中。
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: C })

    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('不在归档集合')
    // 关键断言：文件仍在。
    expect(existsSync(path.join(home, 'sessions', '--E-AM--', C))).toBe(true)
    expect(unarchived).toEqual([])
  })

  it('拒绝路径穿越 id，且不触碰 sessions 目录之外的文件', async () => {
    await seedHome({ archived: [A] })
    // 在 sessions 之外放一个「哨兵」文件；穿越成功的话它会被删掉。
    const sentinel = path.join(home, 'storages', 'workspace.json')
    const before = await readFile(sentinel, 'utf8')

    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: '../storages/workspace' })

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('bad-request')
    expect(await readFile(sentinel, 'utf8')).toBe(before)
  })

  it('拒绝删除**真正在跑**的会话', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      // 权威判据：sessionController.list() 的 running 字段。
      sessionController: {
        list: async () => ({ items: [{ sessionId: A, running: true, agentAvailable: true }] }),
      },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('正在运行')
    expect(existsSync(path.join(home, 'sessions', '--E-AM--', A))).toBe(true)
    expect(unarchived).toEqual([])
  })

  it('⚠️ 回归：跑完的会话（agent 仍 idle 挂着）必须可删除', async () => {
    // 真实缺陷：`agents.get(id) !== undefined` 只是「有活动 agent」，
    // 会话跑完后 agent 仍以 idle 存在，于是所有已完成会话都被误报运行中、
    // 永远删不掉（用户报障）。
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionController: {
        list: async () => ({ items: [{ sessionId: A, running: false, agentAvailable: true }] }),
      },
      // 这个替身会「存在」，但 status 是 idle —— 不得据此阻断删除。
      agents: { get: () => ({ id: A, status: 'idle' }) },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(true)
    expect(result.value.removed.logDirectory).toBe(true)
    expect(unarchived).toEqual([A])
  })

  it('agents 替身只有 idle 状态（无 sessionController）时同样可删除', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      agents: { get: () => ({ id: A, status: 'idle' }) },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(true)
    expect(unarchived).toEqual([A])
  })

  it('无 sessionController 时退回 agents 的 running 状态判定', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      agents: { get: () => ({ id: A, status: 'running' }) },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('正在运行')
  })

  it('⚠️ 回归：sessionController.list() 返回**数组**时必须被正确消费', async () => {
    // 真实缺陷：`list()` 源码末尾是 `return items`（数组），而两处调用都写成
    // `listed?.items ?? []` → 恒为空 → 删除闸门退回「agent 存在即运行中」的
    // 旧判据 → 所有已完成会话都删不掉（用户报障「没办法删除，重试也不行」）。
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      // 直接返回数组（真实形状），不是 { items }。
      sessionController: {
        list: async () => [{ sessionId: A, running: false, agentAvailable: true }],
      },
      // 这个替身「存在」但 idle —— 若数组被正确消费，就不该阻断删除。
      agents: { get: () => ({ id: A, status: 'idle' }) },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(true)
    expect(result.value.removed.logDirectory).toBe(true)
  })

  it('数组形态下 running=true 仍被正确识别为运行中', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionController: {
        list: async () => [{ sessionId: A, running: true, agentAvailable: true }],
      },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('正在运行')
  })

  it('兼容 { items } 包装形态（上游改形时不静默失效）', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionController: {
        list: async () => ({ items: [{ sessionId: A, running: true, agentAvailable: true }] }),
      },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('正在运行')
  })

  it('archive.list 用数组形态时把 running 与 live 分开播报', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionController: {
        list: async () => [{ sessionId: A, running: false, agentAvailable: true }],
      },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
    const row = result.value.rows.find((r) => r.sessionId === A)
    expect(row.live).toBe(true)
    expect(row.running).toBe(false)
  })

  it('archive.list 把 running 与 live 分开播报（不合并）', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({
      workspaceRegistry: makeRegistry(),
      sessionController: {
        list: async () => ({ items: [{ sessionId: A, running: false, agentAvailable: true }] }),
      },
    })
    const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
    const row = result.value.rows.find((r) => r.sessionId === A)
    expect(row.live).toBe(true)
    expect(row.running).toBe(false)
  })

  it('日志目录已缺失的归档条目仍可删除（清理幽灵条目的唯一途径）', async () => {
    // 真实数据里 78 个归档条目有 17 个日志目录已不存在；若这里拒绝删除，
    // 这些条目就永远留在列表里，用户无从清理。
    await seedHome({ archived: [A] })
    await rm(path.join(home, 'sessions', '--E-AM--', A), { recursive: true, force: true })

    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })

    expect(result.ok).toBe(true)
    // 没有目录可删，但归档标记与缓存必须被摘掉。
    expect(result.value.removed.logDirectory).toBe(false)
    expect(result.value.removed.archivedMark).toBe(true)
    expect(result.value.removed.projectionCache).toBe(true)
    expect(unarchived).toEqual([A])
  })

  it('批量删除跳过非法与未归档项，逐条给出原因', async () => {
    await seedHome({ archived: [A] })
    const ctx = makeCtx({ workspaceRegistry: makeRegistry() })
    const result = await handleSessionArchiveRpc(ctx, 'archive.deleteMany', {
      sessionIds: [A, C, '../../x'],
    })
    expect(result.ok).toBe(true)
    expect(result.value.deleted.map((d) => d.sessionId)).toEqual([A])
    expect(result.value.failed).toHaveLength(2)
    expect(existsSync(path.join(home, 'sessions', '--E-AM--', C))).toBe(true)
  })
})

describe('未知方法与参数校验', () => {
  it('未知方法返回 bad-request', async () => {
    const ctx = makeCtx({})
    const result = await handleSessionArchiveRpc(ctx, 'archive.nope', {})
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('bad-request')
  })

  it('批量端点拒绝空数组', async () => {
    const ctx = makeCtx({})
    for (const method of ['archive.restoreMany', 'archive.deleteMany']) {
      const result = await handleSessionArchiveRpc(ctx, method, { sessionIds: [] })
      expect(result.ok).toBe(false)
    }
  })

  it('payload 缺失时按空对象处理，不抛错', async () => {
    const ctx = makeCtx({})
    const result = await handleSessionArchiveRpc(ctx, 'archive.delete', undefined)
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('bad-request')
  })
})

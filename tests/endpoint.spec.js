/**
 * HTTP 端点契约的回归用例。
 *
 * 为什么需要这一层：真实 Web 服务器对 `/api/*` 强制鉴权（未带 token 一律 401，
 * 连已知可用的 `/api/jet-hub` 也一样），故**无法**用裸 HTTP 请求区分
 * 「路由未注册」与「未授权」。这里用一个捕获式 connection 替身直接驱动
 * `apply()` 注册出来的 handler，从而真正验证网关契约的四个要点：
 *
 * 1. 路由注册到 `/api/session-archive`，且 `requestBody: 'buffered'`；
 * 2. 非 POST → 405，非 JSON Content-Type → 415，坏 JSON → 400；
 * 3. 报文形状不符（type/method/rpcId/payload）→ 网关级 bad-request；
 * 4. 正常请求 → `{ type: 'server-response', rpcId, result }`，rpcId 必须回显
 *    （网关靠它把响应配回请求；回错 id 会让界面永久挂起）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply, SESSION_ARCHIVE_API_PATH } from '../lib/index.js'

const A = 'session-11111111-1111-1111-1111-111111111111'

let home
let registered

/** 捕获 register() 的路由定义，并把它包成一个可直接调用的 fetch。 */
function makeCtx() {
  registered = []
  const services = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get: (key) => services.get(key),
    // 与真实 cordis 一致：inject 回调立即以「已注入」的 ctx 调用。
    inject: (deps, callback) => {
      services.set('connection', connection)
      callback(ctx)
    },
  }
  const connection = {
    fetch: {
      register: (route) => { registered.push(route) },
    },
  }
  return ctx
}

function post(route, body, { method = 'POST', contentType = 'application/json' } = {}) {
  // GET/HEAD 不允许带 body（Request 构造器会直接抛错），故仅在有 body 时传入。
  const hasBody = method !== 'GET' && method !== 'HEAD'
  return route.fetch(new Request(`http://127.0.0.1:19387${route.path}`, {
    method,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    ...(hasBody ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  }))
}

async function call(route, payload, rpcId = 'rpc-1') {
  const response = await post(route, {
    type: 'client-request',
    rpcId,
    method: 'session-archive',
    payload,
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  // 必须重置：`registered` 由 makeCtx 赋值，不走 makeCtx 的用例会读到上一个用例的残留。
  registered = []
  home = await mkdtemp(path.join(os.tmpdir(), 'dsh-archive-http-'))
  process.env.DSH_HOME = home
  await mkdir(path.join(home, 'storages'), { recursive: true })
  await writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: [A], workspaceIds: [], pinnedSessionIds: [] },
    tables: { workspaces: {} },
  }))
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('端点注册', () => {
  it('注册到 /api/session-archive，POST，buffered body', () => {
    apply(makeCtx())
    expect(registered).toHaveLength(1)
    expect(registered[0].path).toBe(SESSION_ARCHIVE_API_PATH)
    expect(registered[0].path).toBe('/api/session-archive')
    expect(registered[0].methods).toEqual(['POST'])
    expect(registered[0].requestBody).toBe('buffered')
  })

  it('connection 不可用时静默跳过注册，而不是抛错（headless/CLI profile）', () => {
    const ctx = {
      logger: { info() {}, warn() {}, error() {} },
      get: () => undefined,
      // 没有 connection：inject 回调仍会调用，但 get 返回 undefined。
      inject: (deps, callback) => callback(ctx),
    }
    expect(() => apply(ctx)).not.toThrow()
    expect(registered).toHaveLength(0)
  })
})

describe('网关契约', () => {
  it('非 POST 返回 405', async () => {
    apply(makeCtx())
    const response = await post(registered[0], '{}', { method: 'GET' })
    expect(response.status).toBe(405)
  })

  it('非 JSON Content-Type 返回 415', async () => {
    apply(makeCtx())
    const response = await post(registered[0], '{}', { contentType: 'text/plain' })
    expect(response.status).toBe(415)
  })

  it('坏 JSON 返回 400', async () => {
    apply(makeCtx())
    const response = await post(registered[0], '{not json')
    expect(response.status).toBe(400)
  })

  it('报文形状不符时返回网关级 bad-request，并回显 rpcId', async () => {
    apply(makeCtx())
    const cases = [
      { type: 'wrong-type', rpcId: 'r1', method: 'session-archive', payload: { method: 'archive.list', payload: {} } },
      { type: 'client-request', rpcId: 42, method: 'session-archive', payload: { method: 'archive.list', payload: {} } },
      { type: 'client-request', rpcId: 'r2', method: 'other', payload: { method: 'archive.list', payload: {} } },
      { type: 'client-request', rpcId: 'r3', method: 'session-archive', payload: { method: 'archive.list' } },
    ]
    for (const body of cases) {
      const response = await post(registered[0], body)
      const parsed = await response.json()
      expect(parsed.type).toBe('server-response')
      expect(parsed.rpcId).toBe(typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request')
      expect(parsed.result.ok).toBe(false)
      expect(parsed.result.error.code).toBe('gateway/bad-request')
      // 网关契约要求 error.details 存在。
      expect(parsed.result.error.details).toEqual({})
    }
  })

  it('正常请求返回 server-response，并回显 rpcId', async () => {
    apply(makeCtx())
    const { status, body } = await call(registered[0], { method: 'archive.list', payload: {} }, 'rpc-abc')
    expect(status).toBe(200)
    expect(body.type).toBe('server-response')
    expect(body.rpcId).toBe('rpc-abc')
    expect(body.result.ok).toBe(true)
    expect(body.result.value.rows.map((r) => r.sessionId)).toEqual([A])
  })

  it('未知方法经端点返回 bad-request（不是 500）', async () => {
    apply(makeCtx())
    const { body } = await call(registered[0], { method: 'archive.bogus', payload: {} })
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('bad-request')
  })

  it('端点内部抛错时返回 internal 且带原因，不泄露成未处理异常', async () => {
    // 让 workspace.json 变成非法 JSON 之外还制造一个真正的异常：
    // 用 workspaceRegistry 替身抛错，走 archive.restore 的 catch 路径。
    const ctx = makeCtx()
    apply(ctx)
    const registry = { unarchiveSession: async () => { throw new Error('disk on fire') } }
    ctx.get = (key) => (key === 'workspaceRegistry' ? registry : undefined)

    const { body } = await call(registered[0], { method: 'archive.restore', payload: { sessionId: A } })
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('internal')
    expect(body.result.error.message).toContain('disk on fire')
  })
})

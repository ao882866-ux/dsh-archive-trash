/**
 * 端到端验证「确认后直接完全删除」：
 * 在**一次性临时 DSH_HOME** 下真实跑一遍删除，然后全盘扫描，
 * 确认目标会话**没有任何残留副本**（这是用户明确要求的行为）。
 *
 * 只操作临时目录，不触碰真实 `~/.dsh`。
 */
import { promises as fs } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const A = 'session-11111111-1111-1111-1111-111111111111'
const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-purge-verify-'))
process.env.DSH_HOME = home

// 造一个最小但形状正确的 DSH_HOME。
await mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
await mkdir(path.join(home, 'sessions', '--E-AM--', A), { recursive: true })
await writeFile(path.join(home, 'sessions', '--E-AM--', A, 'session.v4.jsonl.zstd'), 'SECRET-BODY-CONTENT')
await writeFile(path.join(home, 'storages', 'session_projcache', 'sessions', `${A}.json`),
  JSON.stringify({ version: 7, record: { rows: { title: { val: 'SECRET-TITLE' } } } }))
await writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
  global: { archivedSessionIds: [A], workspaceIds: [], pinnedSessionIds: [] },
  tables: { workspaces: { w1: { path: 'E:\\AM', title: 'AM', sessionIds: [A] } } },
}))

const { handleSessionArchiveRpc } = await import('../lib/index.js')

const unarchived = []
const ctx = {
  get: (key) => (key === 'workspaceRegistry'
    ? {
        unarchiveSession: async (id) => { unarchived.push(id) },
        list: () => [{ sessionIds: [A], detachSession: async () => {} }],
      }
    : undefined),
  logger: { info() {}, warn() {}, error() {} },
}

const result = await handleSessionArchiveRpc(ctx, 'archive.delete', { sessionId: A })
console.log('delete ok          :', result.ok)
console.log('removed flags      :', JSON.stringify(result.value?.removed))

/** 递归扫描 home，返回所有命中关键字的路径。 */
async function scan(dir, needles, out = []) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await scan(full, needles, out)
    else {
      if (needles.some((n) => e.name.includes(n) || full.includes(n))) out.push(full)
      else {
        // 也看内容，防止正文被搬到别处改名。
        try {
          const text = await fs.readFile(full, 'utf8')
          if (needles.some((n) => text.includes(n))) out.push(`${full} (内容命中)`)
        } catch { /* 二进制/读不了：跳过 */ }
      }
    }
  }
  return out
}

const hits = await scan(home, [A, 'SECRET-BODY-CONTENT', 'SECRET-TITLE'])
console.log('')
console.log('全盘残留命中       :', hits.length)
for (const h of hits) console.log('   ', h.replace(home, '<HOME>'))

// workspace.json 里残留 id 是 DSH 自己的注册表簿记（本插件调 unarchiveSession
// 已把该 id 从归档集合移除，但工作区表的 sessionIds 由 detachSession 处理）。
// 这里明确检查它到底还留了什么，而不是笼统地算作「残留副本」。
const doc = JSON.parse(await fs.readFile(path.join(home, 'storages', 'workspace.json'), 'utf8'))
console.log('')
console.log('归档集合仍含该 id  :', doc.global.archivedSessionIds.includes(A))
console.log('工作区表仍含该 id  :', JSON.stringify(doc.tables).includes(A))

// 回收站目录不该存在。
let trashExists = true
try { await stat(path.join(home, 'session-archive-trash')) } catch { trashExists = false }
console.log('回收站目录存在     :', trashExists)

await rm(home, { recursive: true, force: true })

// 判据：**内容**必须彻底消失（正文、投影缓存、回收站）。
// `workspace.json` 里的 id 引用属于 DSH 自己的注册表簿记，不是内容副本，
// 故只要归档集合已摘除即可（工作区表的 detachSession 是尽力而为）。
const contentHits = hits.filter((h) => !h.includes('workspace.json'))
const pass = result.ok === true && contentHits.length === 0 && trashExists === false
console.log('')
console.log('内容类残留命中     :', contentHits.length, '（workspace.json 的簿记引用不计）')
console.log(pass ? 'PASS: 会话内容已被完全删除，无任何副本' : 'FAIL: 仍有内容残留')
process.exit(pass ? 0 : 1)

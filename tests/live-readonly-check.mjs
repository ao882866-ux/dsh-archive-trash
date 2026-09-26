/**
 * 只读端到端检查：用**真实** DSH_HOME 驱动宿主的 archive.list。
 *
 * 只调 `archive.list`（纯读），不碰 delete/restore，故对真实数据零副作用。
 * 目的：验证「扫目录 + 读 workspace.json + 读标题」这条链路在真实数据形状下
 * 真的能产出结果，而不是只在自造 fixture 上成立。
 */
import { handleSessionArchiveRpc } from '../lib/index.js'

const ctx = {
  get: () => undefined,
  logger: { info() {}, warn() {}, error() {} },
}

const result = await handleSessionArchiveRpc(ctx, 'archive.list', {})
if (result.ok !== true) {
  console.error('FAILED:', JSON.stringify(result))
  process.exit(1)
}

const { rows, summary, home } = result.value
console.log('DSH_HOME      :', home)
console.log('archived rows :', summary.count)
console.log('total bytes   :', summary.totalBytes)
console.log('')
console.log('--- first 8 rows (newest activity first) ---')
for (const row of rows.slice(0, 8)) {
  console.log([
    row.sessionId,
    `| ws=${row.workspaceTitle || '-'}`,
    `| title=${row.title.slice(0, 34)}`,
    `| exists=${row.exists}`,
    `| events=${row.eventCount}`,
    `| updated=${new Date(row.updatedAt).toISOString().slice(0, 16)}`,
  ].join(' '))
}
console.log('')
const missing = rows.filter((r) => !r.exists).length
const untitled = rows.filter((r) => r.title === '(无标题)').length
console.log('log dirs missing :', missing)
console.log('untitled         :', untitled)
console.log('sorted desc?     :', rows.every((r, i) => i === 0 || rows[i - 1].updatedAt >= r.updatedAt))

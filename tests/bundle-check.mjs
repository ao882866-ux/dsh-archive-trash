/** 校验客户端 bundle 的产物契约（不执行它，故不需要 window/React）。 */
import fs from 'node:fs'
import vm from 'node:vm'

const src = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const checks = []
const idMatch = src.match(/id:\s*"([^"]+)"/)
checks.push(['module id 是包名', idMatch?.[1] === 'dsh-session-archive', idMatch?.[1]])
checks.push(['包装在 __ModuleLoader__.load 里', src.includes('window.__ModuleLoader__.load')])
checks.push(['factory 返回 module.exports', src.includes('return module.exports')])
checks.push(['react 保持 external（未内联）', /require\("react"\)/.test(src)])
// 落点是侧栏会话行的悬停按钮条，**不再是** settings.section 独立页面
// （用户要求：融入 DSH 原生会话筛选，别再开一个设置页）。
checks.push(['注册到 sidebar.workspaces.session.row.action', src.includes('sidebar.workspaces.session.row.action')])
checks.push(['不再注册 settings.section 设置页', !src.includes('settings.section')])
checks.push(['两段式确认（data-armed 状态位）', src.includes('data-armed')])
checks.push(['垃圾桶图标内联（DSH 同款 viewBox 16 16）', src.includes('0 0 16 16')])
checks.push(['上膛用错误色（红色）', src.includes('state-error-primary')])
checks.push(['删除按钮只对已归档会话渲染', src.includes('archivedSetSnapshot')])
// ⚠️ 只断言「默认值」是不够的 —— 曾把默认值改成 14 而调用点仍传 16，
// 于是图标没变小、检查却通过。这里断言**常量存在且调用点不写死 16**，
// 真正的渲染尺寸由 delete-button.spec.js 断言 DOM 得出。
checks.push(['垃圾桶尺寸走单一常量 TRASH_ICON_SIZE = 14', /TRASH_ICON_SIZE\s*=\s*14/.test(src)])
checks.push(['调用点不再写死 size: 16', !/TrashIcon,\s*\{\s*size:\s*16\s*\}/.test(src)])
// 删除走两段式确认（第一次点击只上膛，第二次才真的删）。
checks.push(['调用 archive.delete 端点', src.includes('archive.delete')])
checks.push(['删除有上膛状态位（data-armed）', src.includes('data-armed')])
// ⚠️ 回收站功能已按用户要求**整体移除**，不得残留任何入口/端点。
checks.push(['不再注册 sidebar.footer.action（回收站入口）', !src.includes('sidebar.footer.action')])
checks.push(['不再注册回收站面板到 shell.overlay', !src.includes('session-archive-trash-panel')])
checks.push(['不再调用回收站端点', !src.includes('archive.trash') && !src.includes('archive.purge') && !src.includes('restoreFromTrash')])
checks.push(['不再有回收站文案', !src.includes('回收站')])
checks.push(['中文标签保留（charset=utf8）', src.includes('删除')])
checks.push(['不含 minify 后的空产物', src.length > 2000])

// 语法校验：包成函数体解析，不执行。
let syntaxOk = true
let syntaxError
try {
  new vm.Script(src, { filename: 'client.js' })
} catch (error) {
  syntaxOk = false
  syntaxError = error.message
}
checks.push(['语法可解析', syntaxOk, syntaxError])

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && !ok ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)

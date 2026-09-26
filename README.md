# dsh-session-archive

[![test](https://img.shields.io/badge/tests-84%20passing-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**DeepSeek Harness 插件：在侧栏会话行上永久删除已归档会话。**

> A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds a
> delete button to archived session rows in the sidebar, so you can actually
> clean up sessions you no longer need.

归档（archive）在 DSH 里的语义是「从工作区分组界面隐藏」—— 它**不删数据**。
DSH 自带「归档」与「取消归档」，但归档后的会话长期积累后**没有清理入口**。
本插件补上这一块：在「仅显示已归档」的列表里，每个归档会话的行上出现一个
垃圾桶按钮，两段式确认后**永久删除**。

| 能力 | 说明 |
|---|---|
| 删除入口 | 侧栏会话行的悬停按钮条（`sidebar.workspaces.session.row.action`），紧邻 DSH 自带的归档按钮 |
| 删除范围 | **只对已归档会话出现**；普通会话行上没有该按钮 |
| 删除外观 | DSH 同款垃圾桶图标（`IconTrashOutlineRegular` 的路径内联），图形 **14**（与自带归档按钮同尺寸），盒子 16×16 保持对齐 |
| 删除交互 | 两段式：点图标 → **图标变红**（确认态）→ 再点才执行；失焦或 5 秒后自动取消 |
| 删除效果 | **永久删除**（日志目录 + 投影缓存 + 归档标记 + 工作区归属），**不可恢复** |

## 截图

> 把截图放到 `docs/` 下并把下面两行换成你的文件名即可。

| 归档列表里的删除按钮 | 两段式确认（变红） |
|---|---|
| _(待补充：`docs/screenshot-row.png`)_ | _(待补充：`docs/screenshot-confirm.png`)_ |

## 与 DSH 原生筛选配合使用

在侧栏的「筛选会话」里选 **仅显示已归档**，列表里每个归档会话的行上就会出现
垃圾桶按钮 —— 不需要另开一个设置页。这是刻意的设计：**你本来就在那里看归档
会话**，再让你去设置里找第二个列表既重复又别扭。

## 安装

本插件是标准的 DSH profile 插件包。把它放进 profile 的 `node_modules`，
并在 profile 的 `package.json` 里注册：

```bash
# 1. 克隆并构建客户端 bundle
git clone https://github.com/<你的用户名>/dsh-session-archive.git
cd dsh-session-archive
npm install
npm run build

# 2. 放进 profile 的 node_modules
cp -r lib package.json cordis.patch.yml \
  "$DSH_HOME/profiles/desktop/node_modules/dsh-session-archive/"
```

然后在 `$DSH_HOME/profiles/desktop/package.json` 里把包名加进
`dsh.profile.bundles`（本包自带 `cordis.patch.yml`，bundles 机制会在启动时
自动把它叠进 patch 栈）：

```json
"bundles": [ "...", "dsh-session-archive" ]
```

### ⚠️ 必须**重启 DSH**，热重载不够

两个真实踩过的坑，都会表现成「界面有按钮，但点了没反应」：

1. **宿主模块不会被重新导入。** ESM 模块一旦被 import 就进缓存，改写
   `lib/index.js` **不会**让 `apply()` 重跑 —— 即使 profile 的
   `patchReload: "live"` 重组了配置树。实测（顶层插桩验证）：改动
   `cordis.patch.yml` 触发重组后，模块顶层代码**没有**再次执行。
   所以改宿主代码后必须重启，否则跑着的仍是旧逻辑。

2. **手写进 `cordis.patch.yml` 的 insert 会被插件管理器抹掉。**
   在 profile 里装/卸任何插件时，DSH 会重写该文件，手写的 `- insert:` 行
   随之消失 → 宿主条目从 loader 树移除 → 端点不存在 → 按钮在（客户端
   bundle 还在浏览器里）但请求打不通。

**结论**：用 `dsh.profile.bundles` 注册（持久、启动时合成），不要只依赖
手写 patch。改动宿主代码后重启。

## 为什么删除必须自己实现

DSH **没有**会话删除 API：

- `ctx.sessionQuery` 只有读（list / search / readTitle / readEvents …）；
- `ctx.workspaceRegistry` 只有 `archiveSession` / `unarchiveSession`；
- `ctx.workspaceController`（Remote 面）同样只有 archive / unarchive / pin。

所以删除只能操作磁盘上的四份状态：

| 目标 | 位置 |
|---|---|
| 会话日志目录 | `$DSH_HOME/sessions/<转义 cwd>/<sessionId>/` |
| 投影缓存 | `$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json` |
| 工作区归属 | `Workspace.detachSession(sessionId)` |
| 归档集合 | `workspaceRegistry.unarchiveSession(sessionId)` |

## 安全约定（真实风险）

**删除是不可恢复的**（`deleteSession` 直接 `fs.rm`），故宿主侧有四道闸门
（都在 `lib/index.js`，不在客户端 —— 客户端不做任何安全判定，否则伪造请求
就能绕过）：

1. **只允许删除当前确实处于归档状态的会话**。判据是 id ∈
   `workspace.json` 的 `archivedSessionIds`。没有这道闸门，一个伪造的
   `archive.delete` 就能删掉任意会话。
2. **id 必须先通过形态校验**（`isPlausibleSessionId`）。id 会被拼进文件路径，
   放行 `../` 等于任意文件删除。该校验拒绝路径分隔符、`..` 与非
   `session-<uuid>` / 裸 uuid 的形态。
3. **先摘除归档标记与工作区归属，再删文件**。这样失败方向是「会话还在、
   只是被取消归档」—— 用户可重试；反过来则是「文件没了但归档集合还留着」，
   界面会出现幽灵条目。
4. **正在运行的会话拒绝删除**。DSH 的写路径持有单写者句柄，日志被抽走会让
   下一次 append 失败，表现为会话无故损坏。

客户端另有**两段式确认**（点一次只上膛、图标变红，再点才执行；失焦或 5 秒
自动取消）—— 不可逆操作绝不能一击执行。

删除操作会写 `warn` 级日志（含会话 id），便于事后追溯。

### 日志目录已缺失的条目仍可删除

真实数据里 78 个归档条目有 17 个日志目录已不存在（会话被外部清理过）。
这类**幽灵条目**恰恰是最该清理的，故「目录不存在」不构成拒绝理由：
宿主照常摘掉归档标记与投影缓存，只是没有目录可删。

## 架构

```
lib/pure.js      纯函数：排序 / 检索 / 可删除性判定 / 工作区解析（可单测，无 IO）
lib/index.js     宿主：RPC 处理器 + HTTP 端点注册 + 文件系统操作
lib/client.js    客户端 bundle（由 client-src/ 经 esbuild 打包）
client-src/      UI 源码（React.createElement，不用 JSX）
tests/           84 个单测 + bundle 契约检查
```

客户端 bundle 的产物形态必须符合 DSH 客户端模块加载器契约：

```js
window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { ... } })
```

`id` 必须是**包名**（`dsh-session-archive`），`react` / `react-dom` 必须保持
external（宿主 shell 提供单例；打进来会产生第二个 React 实例，hooks 直接报错）。

宿主侧 `inject = []`，`connection` 通过 `ctx.inject(['connection'], ...)`
**可选挂载**：该服务只由 Web bundle 提供，headless / CLI profile 里不存在，
静态 inject 会让插件在那些 profile 里永久 pending，导致整个 profile
以「1 entry did not activate」启动失败。

## RPC 端点

| 方法 | 作用 |
|---|---|
| `archive.list` | 列出归档会话（含标题 / 工作区 / 大小 / 运行状态） |
| `archive.restore` | 取消归档（单条） |
| `archive.restoreMany` | 取消归档（批量） |
| `archive.delete` | **永久删除**（单条） |
| `archive.deleteMany` | **永久删除**（批量） |

## 测试

```bash
npm test        # 84 个单测
npm run check   # bundle 契约检查（21 项）
```

覆盖四类：

- `tests/pure.spec.js` —— 排序、检索、可删除性、工作区解析；
- `tests/rpc.spec.js` —— RPC 处理器，含**安全边界**：拒绝未归档会话、
  拒绝路径穿越、拒绝运行中会话、日志缺失仍可删、永久删除后无残留；
- `tests/endpoint.spec.js` —— HTTP 网关契约：路由注册、405/415/400、
  报文形状校验、rpcId 回显；
- `tests/delete-button.spec.js` —— 会话行按钮：仅对归档会话渲染、两段式确认、
  图标渲染尺寸、对齐契约。

删除相关用例全部在**一次性临时 `DSH_HOME`** 下运行，绝不触碰真实 `~/.dsh`。

端到端验证「删除后无残留副本」（同样只动临时目录）：

```bash
node tests/verify-permanent-delete.mjs
```

只读检查真实环境的归档现状（零副作用，只调 `archive.list`）：

```bash
node tests/live-readonly-check.mjs
```

## 已知限制

- **标题来源**：优先 `ctx.sessionQuery.readTitleSnapshots`（权威、live-preferred），
  不可用时回退读投影缓存文件。两者都没有的会话显示「(无标题)」。
- **最后活动时间**：优先取投影缓存文件的 mtime（「最后一次被写」的直接证据），
  否则退回 header 的 `createdAt`（**创建**时间）。
- **事件数**：来自 `sessionPersistence.stat()`；服务不可用时为 0（不臆造）。
- **工作区归属**优先按 sessionId 解析（会话可被移动），退回按 cwd 匹配
  （大小写不敏感 —— Windows 路径大小写不敏感）。
- **删除不可恢复**，没有回收站。这是刻意的设计选择，见上文「安全约定」。

## License

[MIT](LICENSE)

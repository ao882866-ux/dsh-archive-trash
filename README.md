# dsh-session-archive

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**为 DSH 已归档会话添加垃圾桶图标，一键删除，极简会话管理。**

> A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that adds a
> trash button to archived session rows in the sidebar, so you can actually
> clean up sessions you no longer need.

归档（archive）在 DSH 里的语义是「从工作区分组界面隐藏」—— 它**不删数据**。
DSH 自带「归档」与「取消归档」，但归档后的会话长期积累后**没有清理入口**。
本插件补上这一块：在「仅显示已归档」的列表里，每个归档会话的行上出现一个
垃圾桶按钮，两段式确认后**永久删除**。

## 功能

| 能力 | 说明 |
|---|---|
| 删除入口 | 侧栏会话行的悬停按钮条（`sidebar.workspaces.session.row.action`），紧邻 DSH 自带的归档按钮 |
| 删除范围 | **只对已归档会话出现**；普通会话行上没有该按钮 |
| 删除外观 | DSH 同款垃圾桶图标（`IconTrashOutlineRegular` 路径内联），图形 **14**（与自带归档按钮同尺寸），盒子 16×16 保持对齐 |
| 删除交互 | 两段式：点图标 → **图标变红**（确认态）→ 再点才执行；失焦或 5 秒后自动取消 |
| 删除效果 | **永久删除**（日志目录 + 投影缓存 + 归档标记 + 工作区归属），**不可恢复** |
| 子代理会话 | 删除主会话时**自动级联删除**它的子代理（智能体团队）会话，不留孤儿 |

## 截图

归档列表里，每个已归档会话的行上会出现本插件的垃圾桶按钮 ——
就在 DSH 自带的**归档**按钮右边：

![侧栏会话行上的删除按钮](docs/screenshot-annotated.png)

> 左侧灰色圈是 DSH 自带的「归档」，右侧红圈是本插件的「永久删除」。

## 安装

本插件自带 `cordis.patch.yml` 与已构建的 `lib/`，**不需要 npm / pnpm，也不需要
本地构建**。

### 推荐：在 DSH 插件界面安装

打开 **设置 → 插件 → 添加插件**，在「包名或地址」里填入本仓库地址：

```
https://github.com/ao882866-ux/dsh-session-archive
```

安装完成后按提示重启 DSH。

### 其他方式

```bash
# 命令行（桌面端的 desktop profile 由应用独占，CLI 会拒绝写入）
dsh plugin --profile <profile> add github:ao882866-ux/dsh-session-archive
```

手动复制：把 `lib/` 与 `package.json`、`cordis.patch.yml` 放进
`<profile>/node_modules/dsh-session-archive/`，再把包名加进 profile
`package.json` 的 `dsh.profile.bundles`：

```json
"bundles": [ "...", "dsh-session-archive" ]
```

> profile 默认在 `~/.dsh/profiles/desktop`（可用 `DSH_HOME` 覆盖）。

### ⚠️ 改完必须重启 DSH

宿主模块一旦被 import 就进 ESM 缓存，改写 `lib/index.js` **不会**让 `apply()`
重跑 —— 即使 profile 配了 `patchReload: "live"`。改动宿主代码后必须重启，
否则跑着的仍是旧逻辑。

> 也不要只依赖手写进 `cordis.patch.yml` 的 `- insert:`：在 profile 里装/卸
> 任何插件时 DSH 会重写该文件，手写的 insert 会消失。用
> `dsh.profile.bundles` 注册才是持久的。

## 使用

1. 侧栏「筛选会话」里选 **仅显示已归档**；
2. 每个归档会话行上会出现垃圾桶按钮，**点一下**进入确认态（图标变红）；
3. **再点一下**才真正删除；失焦或 5 秒不动会自动取消。

不需要另开设置页 —— 你本来就在「已归档」列表里看这些会话，再让你去设置里
找第二个列表既重复又别扭。

删除主会话时，它的子代理会话会一并删除。**分叉（fork）出来的会话不会被删**
—— 那是独立会话，你还要接着聊。

## 实现说明

### 为什么删除必须自己实现

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

此外还要把**活着的会话**从内存摘除（`ctx.sessions`），否则
`sessionQuery.listSessions()` 仍会把它列出来。

### 删除顺序

删除会触碰磁盘上的多份状态，顺序是刻意设计的：
**先摘除活着的会话 → 删文件并确认删净 → 最后才摘归档标记与工作区归属**。

1. **先把活着的会话从 `ctx.sessions` 摘除**（`liveEntryFor` + `detachEntered`）。
   摘除会触发 `session/disposed` → 持久化写入句柄 `close()`（释放单写者租约，
   避免删完之后后台 append 又把日志文件建出来），并让客户端丢弃该行。
   必须在删文件**之前**，否则后台写入可能重建日志。
2. **删日志目录并复核删净**（`removeTree`：删完检查存在性，仍在则重试）。
   同名会话在多个 bucket 下都有目录时**全部删除**。
3. **删投影缓存**（失败不算致命 —— 它不是会话本体）。
4. **到这里才摘归档标记**（`unarchiveSession`）。
5. **从工作区摘除归属**（`detachSession`）。

#### 为什么归档标记必须最后摘

侧栏的可见性判据是：

```js
// dsh-client-ui-workspace 的 sessionVisible()，archivedFilter === 'default'
return !archived.has(session.id)
```

注意 **「取消归档」恰恰会让这一行变得可见**。所以归档标记必须在**数据确实
删净之后**才摘：若先摘标记而删文件失败（文件被占用 / `EPERM` / 瞬时 I/O），
会话就会留在磁盘上却不再归档，以普通会话身份回到列表。

按上面的顺序，失败方向永远是安全的：

| 失败位置 | 结果 | 用户感受 |
|---|---|---|
| 第 1~3 步 | 会话**原样还在、仍然归档** | 「删除失败，可重试」，会话仍在归档列表里 |
| 第 4 步 | 文件已删净、归档集合还留着（幽灵条目） | 本插件**仍然允许删除**这种条目，可清理 |

也就是说：**绝不会**出现「不再归档、却还在磁盘上」的会话。

客户端侧配套：删除成功后调用 `ctx.sessions.refresh()` 重新拉取列表基线。
宿主摘除活动会话会转发 `api-session/removed`，但会话在删除前若已不在内存中
（进程重启后从未打开过），就不会有这个事件，只能靠主动刷新兜底。

### 级联删除子代理会话

子代理（智能体团队）会话是**独立会话**：有自己的日志目录、自己的投影缓存，
只是头里多了 `origin: 'subagent'` 与 `parentSession`。所以只删主会话会把它们
留成**孤儿** —— 占着磁盘，却再也无法通过父会话被找到。

删除主会话时会**递归**收集它的全部子代理后代并逐个删除。

#### 血缘判据（关键，错了会误删）

```js
// 与 DSH 自己一致：dsh-session-persistence-jsonl 的 prepareStoredMigration
source.header.origin === 'subagent' && source.header.parentSession === id
```

⚠️ **必须同时判两个字段**：

- 只看 `parentSession` 会把 **fork（分叉）** 也算进来。fork 同样带
  `parentSession`，但它是**独立会话** —— 用户分叉出来就是要接着聊的，
  删掉原会话**不该**连带删它。
- 只看 `origin === 'subagent'` 则无法确定父是谁。

#### 顺序：深的先删，主会话最后

后代按**由深到浅**（叶子在前）排序后逐个删除，最后才删主会话。这样中途失败
不会留下「父已删、子成孤儿」——孤儿子代理再也没法通过父会话被找到，
只能永久留在磁盘上。

子代理全部删净之后才动主会话。任一子代理正在运行时会整体跳过，主会话保持
归档，可稍后重试。

#### 血缘读取：磁盘是唯一权威

1. **先扫磁盘** `sessions/` 下的日志文件（只读开头 64KB，解 zstd 第一帧），
   且只接受满足 `header.id === 所在目录名` 的头；
2. `ctx.sessionPersistence.list()` **只作为补漏**，且**不得覆盖**磁盘已确认的头。

⚠️ **为什么要求「头里的 id == 目录名」**：头里的 `id` 是日志文件的**自称**，
而我们要删的是**磁盘目录**。血缘一律以目录名为准，两者不一致的条目不参与
级联，以免误伤其他会话。

这正是 DSH 自己的不变量（`dsh-session-persistence-jsonl` 的 `assertStoredId`：
「session header id "X" does not match session id "Y"」），
真实数据的可解析会话全部满足，所以这个约束零代价。

血缘读取整体失败时**降级为「只删主会话」**，而**不**阻断删除 ——
宁可留下孤儿子代理让用户手动清理，也不能因为解析不了血缘就整个删不掉。

#### 两种 id 校验：入口用形态，磁盘用路径安全

这是**刻意分开**的两个概念：

| 场景 | 校验 | 判据 | 为什么 |
|---|---|---|---|
| RPC 入口（id 来自客户端，可伪造） | `isPlausibleSessionId` | 必须是 `session-<uuid>` / 裸 uuid | 只放行已知形态，防伪造请求 |
| 磁盘发现的 id（目录名 / 日志头） | `isSafePathSegment` | 只要拼进路径不会逃出基目录 | 真实数据里有 `fusion-worker-<uuid>` 这类**非 uuid 形态**的会话目录，用形态校验会漏删 |

`isSafePathSegment` 拒绝：空串、`.`、`..`、路径分隔符、`:`（盘符 / NTFS ADS）、
控制字符与 NUL、超长（>200）。

## 安全约定

**删除是不可恢复的**（`deleteSession` 直接 `fs.rm`），故宿主侧有六道闸门
（都在 `lib/index.js`，不在客户端 —— 客户端不做任何安全判定，否则伪造请求
就能绕过）：

1. **只允许删除当前确实处于归档状态的会话**。判据是 id ∈
   `workspace.json` 的 `archivedSessionIds` —— 伪造的 `archive.delete`
   无法触碰未归档的会话。
2. **入口 id 必须通过形态校验**（`isPlausibleSessionId`）。id 会被拼进文件路径，
   故只放行 `session-<uuid>` / 裸 uuid 形态，拒绝路径分隔符与 `..`。
3. **所有路径拼接都做包含性检查**（`containedPath`）：`projectionCachePath`
   与每个待删目录都必须落在 `$DSH_HOME` 对应基目录内，越界返回 `undefined`
   并跳过。这是**结构性**防护 —— 不依赖「调用方已经校验过 id」。
4. **磁盘 id 用路径安全校验**（`isSafePathSegment`），且**要求头里的 id
   与所在目录名一致**。
5. **正在运行的会话拒绝删除**。DSH 的写路径持有单写者句柄，日志被抽走会让
   下一次 append 失败，表现为会话无故损坏。**子代理会话同样受此闸门约束**。
6. **级联删除只认 `origin === 'subagent'` 的血缘**，且子代理先于主会话处理 ——
   这既保证不留孤儿，也保证**不误删 fork**。

客户端另有**两段式确认**（点一次只上膛、图标变红，再点才执行；失焦或 5 秒
自动取消）—— 不可逆操作绝不能一击执行。

删除成功写 `warn` 级日志（含会话 id 与级联删掉的子代理数量）、失败写
`error` 级日志，便于事后追溯。

### 日志目录已缺失的条目仍可删除

会话被外部清理后，归档列表里可能留下日志目录已不存在的条目。这类**幽灵条目**
恰恰是最该清理的，故「目录不存在」不构成拒绝理由：宿主照常摘掉归档标记与
投影缓存，只是没有目录可删。

## RPC 端点

| 方法 | 作用 |
|---|---|
| `archive.list` | 列出归档会话（含标题 / 工作区 / 大小 / 运行状态） |
| `archive.restore` | 取消归档（单条） |
| `archive.restoreMany` | 取消归档（批量） |
| `archive.delete` | **永久删除**（单条，含级联删除其子代理会话） |
| `archive.deleteMany` | **永久删除**（批量，逐条同样级联） |

## 开发

普通安装**不需要**这一步。只有要改 `client-src/` 或 `lib/index.js` 时才需要：

```bash
pnpm install          # 或 npm install
pnpm build            # 重新生成 lib/client.js
```

> ⚠️ **pnpm 10+ 会拦截依赖的构建脚本**，若不处理，`pnpm install` 会以
> **exit 1** 结束（`ERR_PNPM_IGNORED_BUILDS`），随后 `pnpm build` 也会因依赖
> 状态检查失败而报错 —— esbuild 必须跑 postinstall 才能落地平台二进制。
>
> 仓库已带 `pnpm-workspace.yaml` 显式放行 esbuild，正常克隆下来即可直接安装。
> 若你的环境仍提示，执行一次 `pnpm approve-builds --all` 即可。
> 用 npm 不会阻塞（只警告）。

### 结构

```
lib/pure.js      纯函数：排序 / 检索 / 可删除性判定 / 血缘解析（可单测，无 IO）
lib/index.js     宿主：RPC 处理器 + HTTP 端点注册 + 文件系统操作
lib/client.js    客户端 bundle（由 client-src/ 经 esbuild 打包）
client-src/      UI 源码（React.createElement，不用 JSX）
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

## 已知限制

- **删除不可恢复**，没有回收站。这是刻意的设计选择。
- **标题来源**：优先 `ctx.sessionQuery.readTitleSnapshots`（权威、live-preferred），
  不可用时回退读投影缓存文件。两者都没有的会话显示「(无标题)」。
- **最后活动时间**：优先取投影缓存文件的 mtime（「最后一次被写」的直接证据），
  否则退回 header 的 `createdAt`（**创建**时间）。
- **事件数**：来自 `sessionPersistence.stat()`；服务不可用时为 0（不臆造）。
- **工作区归属**优先按 sessionId 解析（会话可被移动），退回按 cwd 匹配
  （大小写不敏感 —— Windows 路径大小写不敏感）。
- **删除失败时不会留下「未归档但仍在磁盘」的会话**：删文件失败 → 会话原样
  保持归档，可重试；只有摘标记失败 → 留下可再次删除的幽灵条目。
- **同名会话在多个 bucket 下都有目录**时会全部删除；目录若在删除后被后台写入
  重建，`removeTree` 会重试至多 5 次（每次退避 60ms），仍失败则整体报失败并
  保持归档状态。
- **级联删除子代理会话**（智能体团队）：删主会话时会递归删除其
  `origin === 'subagent'` 的后代。**fork（分叉）不会被删**。
  子代理正在运行时整体跳过，主会话保持归档，可稍后重试。
- **非 uuid 形态的会话 id 也能删**（如 `fusion-worker-<uuid>`）：
  磁盘 id 走路径安全校验而非 uuid 形态校验，故不会漏删。

## License

[MIT](LICENSE)

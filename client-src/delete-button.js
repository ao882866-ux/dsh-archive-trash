/**
 * 会话行上的「删除归档会话」按钮 —— DSH 同款垃圾桶图标，两段式确认。
 *
 * ## 交互（按用户要求）
 *
 *   1. 点击图标 → 图标变**红色**（进入确认态）；
 *   2. 再次点击 → 真正执行删除；
 *   3. 失焦 / 5 秒超时 → 自动取消，回到常态。
 *
 * ## 图标为什么是内联 SVG，而不是 import 组件
 *
 * 视觉上要与 DSH 自带的归档/置顶按钮**完全同款**，所以直接复刻
 * `@deepseek-ai/dsh-client-ui-primitives` 的 `IconTrashOutlineRegular`：
 * viewBox `0 0 16 16`、`fill: none`、`stroke: currentColor`、`strokeWidth: 1`，
 * 路径逐字取自该包。
 *
 * ⚠️ **不 import 该组件**：客户端 bundle 通过 `window.__ModuleLoader__` 加载，
 * 跨包 import 需要宿主 shell 把该包暴露为共享依赖。本插件没有声明那层
 * external，import 会让 esbuild 把整份 primitives 打进产物（体积暴涨），
 * 或在运行时解析失败（按钮直接不渲染）。内联 5 条 path 是零依赖且等价的。
 *
 * ## 对齐（贴合同行按钮的 CSS 契约）
 *
 * DSH 的按钮条是 `.rowActions { display:inline-flex; align-items:center; gap:10px }`，
 * 自带 `.iconButton { width:16px; height:16px; padding:0; border:none; background:none }`。
 * 故本按钮：**16×16、零 padding/border/margin**，横向间隔完全交给 `gap`。
 * 两种状态的盒子尺寸必须一致，只有颜色变 —— 否则点击瞬间整排错位。
 *
 * ⚠️ **只在已归档会话上渲染**（见 `client-src/index.js` 的
 * `archivedSetSnapshot`）。行上出现一个能删数据的按钮而不加范围限制，
 * 是这次事故的直接教训。
 *
 * ⚠️ **删除是永久的、不可恢复的**（宿主侧 `deleteSession` 直接 `fs.rm`）。
 * 用户明确要求「确认删除后直接完全删除」，故文案与提示都必须如实写明不可恢复，
 * 不能写成「移入回收站」。
 */

import * as React from 'react'

const h = React.createElement

/** 进入确认态后，多久没再点就自动取消（毫秒）。 */
const CONFIRM_TIMEOUT_MS = 5000

/**
 * DSH `IconTrashOutlineRegular` 的路径（逐字取自 ui-primitives）。
 *
 * 该 artwork 里共 8 条 path，后 3 条属于同文件的圆形警告图标，故只取前 5 条。
 */
const TRASH_PATHS = [
  'M1.28149 3.88831H14.7187',
  'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
  'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
  'M6.44946 6.98926V11.1238',
  'M9.55054 6.98926V11.1238',
]

/**
 * 垃圾桶图标的默认渲染尺寸。
 *
 * ⚠️ **这个常量是唯一来源，调用点不要再传 `size`**。
 * 上一轮把默认值从 16 改成 14 却毫无效果 —— 因为三处调用点都显式传了
 * `size: 16`，默认值根本没被用到（而当时的测试只断言默认值，于是"通过"了，
 * 是个空洞的测试）。现在导出常量，测试直接断言**调用点实际渲染出的宽度**。
 *
 * 取值依据（实测 artwork 包围盒，viewBox 16）：
 * - 归档 `IconArchiveOutlineArtwork`  图形 13.00×13.00（填充 81%）
 * - 垃圾桶 `IconTrashOutlineArtwork`  图形 12.94×12.45（填充 81%）
 *
 * 两者图形尺寸几乎一致，故缩到 14 是为了**让描边变细**：viewBox 16 渲染到
 * 16px 时 `strokeWidth:1` 是实打实的 1px，而 DSH 行按钮把同类图标渲染在 14px，
 * 描边被缩成 0.875px。渲染到 14px 后描边同样缩放，视觉粗细才对得上。
 */
export const TRASH_ICON_SIZE = 14

/**
 * 与 DSH 自带图标按钮同款的垃圾桶。
 *
 * @param props.size - 图形边长；**默认 `TRASH_ICON_SIZE`**，调用点通常不该传。
 */
export function TrashIcon({ size = TRASH_ICON_SIZE }) {
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-hidden': 'true',
    strokeWidth: 1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }, TRASH_PATHS.map((d, i) => h('path', { key: i, d, stroke: 'currentColor' })))
}

const S = {
  /**
   * 与同排 `iconButton` 同一盒子：16×16、零 padding。
   *
   * 颜色只表达状态，**不改变盒子尺寸**，故两种状态间不会重排。
   */
  button: (armed, busy) => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none',
    boxSizing: 'border-box',
    // 与自带 iconButton 的 16×16 对齐 —— 这是「间隔对齐」的关键。
    width: '16px',
    height: '16px',
    padding: 0,
    margin: 0,
    // 显式写 borderWidth/borderStyle 而非简写 `border:'none'`：
    // 简写在部分引擎里会归一化成 `borderWidth: medium`，让「零边框」无法断言。
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: 'var(--dsw-radius-xs)',
    background: 'none',
    // 常态与自带按钮同为 tertiary；上膛（或失败）转 error —— 用户要求的红色。
    color: armed
      ? 'var(--dsw-alias-state-error-primary)'
      : 'var(--dsw-alias-label-tertiary)',
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.6 : 1,
  }),
}

/**
 * 一个会话行的删除按钮。
 *
 * @param props.sessionId - 本行对应的会话 id（slot 注入）。
 * @param props.rpcCall - 宿主端点调用函数（slot 注入）。
 * @param props.archivedSetSnapshot - 返回当前已归档 id 集合的函数（slot 注入）。
 * @param props.refreshSessionList - 删除成功后刷新会话列表基线的函数（slot 注入）。
 */
export function DeleteArchivedSessionButton({ sessionId, rpcCall, archivedSetSnapshot, refreshSessionList }) {
  const [armed, setArmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const mounted = React.useRef(true)

  React.useEffect(() => () => { mounted.current = false }, [])

  // 进入确认态后自动解除：用户点到一半走神，不该留一个「已上膛」的删除键。
  React.useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => {
      if (mounted.current) setArmed(false)
    }, CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [armed])

  // ⚠️ 只在**已归档**会话上出现。这是范围闸门，不是可选优化：
  // 少了它，每个普通会话行都会多出一个删除键。
  const archived = archivedSetSnapshot().has(sessionId)
  if (!archived) return null

  const onClick = async () => {
    if (busy) return
    if (!armed) {
      setArmed(true)
      setFailed(false)
      return
    }
    // 第二段：真正删除。
    setBusy(true)
    try {
      await rpcCall('archive.delete', { sessionId })
    } catch {
      if (mounted.current) {
        setArmed(false)
        setFailed(true)
      }
      if (mounted.current) setBusy(false)
      return
    }

    // ⚠️ 成功后**必须**刷新列表基线。
    // 侧栏可见性判据是 `!archived.has(id)`（archivedFilter==='default'），
    // 所以宿主把该会话移出归档集合之后，这一行反而会**变得可见**。
    // 不同步列表的话，它就以「未归档会话」的身份留在侧栏 —— 用户看到的
    // 就是「点击删除后它又进入未归档列表」。
    //
    // 刻意放在 `catch` **之外**：数据已经删掉了，刷新只是界面同步，
    // 它失败绝不能被报成「删除失败」（那会诱导用户去重试一个已删的会话）。
    // 行随列表更新消失，故这里不再 setState（避免对已卸载组件写状态）。
    try {
      refreshSessionList?.()
    } catch {
      // 界面同步失败不影响删除结果。
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const title = failed
    ? '删除失败，点击重试'
    : armed
      ? '再次点击即永久删除该会话（不可恢复）'
      : '永久删除该归档会话（不可恢复）'

  return h('button', {
    type: 'button',
    style: S.button(armed || failed, busy),
    // 行内按钮条里的点击不会冒泡到行本身（DSH 的 strip 契约），
    // 但显式阻止一次更稳妥 —— 否则点删除会顺带打开该会话。
    onClick: (event) => {
      event.stopPropagation()
      void onClick()
    },
    // 失焦即取消，避免「上膛」状态在用户切走后被误触。
    onBlur: () => { if (!busy) setArmed(false) },
    // 悬停提升图标色（inline style 写不了 :hover）。上膛时保持红色。
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    title,
    'aria-label': armed ? `确认删除会话 ${sessionId}` : `删除归档会话 ${sessionId}`,
    'data-armed': armed ? 'true' : undefined,
    'data-failed': failed ? 'true' : undefined,
  },
  h('span', {
    style: {
      display: 'inline-flex',
      // 悬停且未上膛时提升为 primary；上膛/失败由外层红色统一控制。
      color: !armed && !failed && hovered ? 'var(--dsw-alias-label-primary)' : 'inherit',
    },
  }, h(TrashIcon, { size: TRASH_ICON_SIZE })))
}

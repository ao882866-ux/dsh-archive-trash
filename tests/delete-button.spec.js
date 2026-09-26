/**
 * 会话行删除按钮的回归用例。
 *
 * 重点锁死三件事（都是用户直接提出的行为要求或事故教训）：
 * 1. **只在已归档会话上渲染** —— 少这个范围闸门，每个普通会话行都会多出删除键；
 * 2. **两段式**：第一次点击只进入确认态、**不发请求**；第二次才真的删；
 * 3. 取消路径（失焦/超时）能退回未上膛状态。
 *
 * ⚠️ 第 2 条必须断言「第一次点击**没有**调用 rpcCall」。只断言「最终调用了」
 * 会漏掉「一次点击就删」的实现 —— 那正是用户要避免的。
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { DeleteArchivedSessionButton } from '../client-src/delete-button.js'

const h = createElement

/** 挂载到真实 DOM，返回可交互的句柄。 */
async function mount(props) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { JSDOM } = await import('jsdom')

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  await act(async () => { root.render(h(DeleteArchivedSessionButton, props)) })
  return { container, root, act, dom }
}

const A = 'session-11111111-1111-1111-1111-111111111111'

function makeProps(overrides = {}) {
  const rpcCall = vi.fn(async () => ({ ok: true }))
  return {
    sessionId: A,
    rpcCall,
    archivedSetSnapshot: () => new Set([A]),
    ...overrides,
  }
}

const findButton = (container) => container.querySelector('button')

describe('渲染范围', () => {
  it('已归档会话渲染垃圾桶按钮', async () => {
    const { container, root, act } = await mount(makeProps())
    expect(findButton(container)).not.toBeNull()
    // 图标风格：按钮内是 svg，而不是文字。
    expect(findButton(container).querySelector('svg')).not.toBeNull()
    await act(async () => { root.unmount() })
  })

  it('⚠️ 未归档会话**不渲染**按钮（避免每个会话行都出现删除键）', async () => {
    const { container, root, act } = await mount(makeProps({
      archivedSetSnapshot: () => new Set(),
    }))
    expect(findButton(container)).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('归档集合不含本行 id 时不渲染（其他会话归档了也不算）', async () => {
    const other = 'session-22222222-2222-2222-2222-222222222222'
    const { container, root, act } = await mount(makeProps({
      archivedSetSnapshot: () => new Set([other]),
    }))
    expect(findButton(container)).toBeNull()
    await act(async () => { root.unmount() })
  })

  it('workspaces 服务缺失（快照为空集）时不渲染，而不是抛错', async () => {
    const { container, root, act } = await mount(makeProps({
      archivedSetSnapshot: () => new Set(),
    }))
    expect(findButton(container)).toBeNull()
    await act(async () => { root.unmount() })
  })
})

describe('外观与对齐（贴合同行 iconButton 的 CSS 契约）', () => {
  /**
   * DSH 的按钮条契约（来自 ui-workspace 的 Rows 样式表）：
   *   .rowActions { display:inline-flex; align-items:center; gap:10px }
   *   .iconButton { width:16px; height:16px; padding:0; border:none; background:none }
   *
   * 本按钮必须与 iconButton 同尺寸、零内边距，横向间隔才能完全由 gap 统一控制。
   */
  it('16×16、零 padding/border/margin —— 与同行图标按钮同盒', async () => {
    const { container, root, act } = await mount(makeProps())
    const style = findButton(container).style
    expect(style.width).toBe('16px')
    expect(style.height).toBe('16px')
    expect(style.padding).toBe('0px')
    expect(style.margin).toBe('0px')
    expect(style.boxSizing).toBe('border-box')
    // 显式的零边框（生产代码刻意不用简写 `border:'none'`，见其注释）。
    expect(style.borderWidth).toBe('0px')
    expect(style.borderStyle).toBe('none')
    await act(async () => { root.unmount() })
  })

  it('渲染垃圾桶图标（DSH 同款 svg，5 条 path），不是文字', async () => {
    const { container, root, act } = await mount(makeProps())
    const svg = findButton(container).querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('stroke-width')).toBe('1')
    // 垃圾桶本体 5 条路径。
    expect(svg.querySelectorAll('path')).toHaveLength(5)
    // 不带文字标签（图标风格）。
    expect(findButton(container).textContent).toBe('')
    await act(async () => { root.unmount() })
  })

  it('⚠️ 回归：按钮里**实际渲染**的图标必须是 14（不能只改默认值）', async () => {
    // 真实缺陷：上一轮把 `TrashIcon` 的**默认值**改成 14，但调用点显式传了
    // `size: 16`，默认值根本没被用到 → 图标一点没变小；而当时的测试只断言
    // 默认值，于是"通过"了（空洞的测试）。这里断言**渲染结果**。
    const { container, root, act } = await mount(makeProps())
    const svg = findButton(container).querySelector('svg')
    expect(svg.getAttribute('width')).toBe('14')
    expect(svg.getAttribute('height')).toBe('14')
    await act(async () => { root.unmount() })
  })

  it('⚠️ 上膛前后盒子尺寸不变（否则点击瞬间整排错位）', async () => {
    const { container, root, act } = await mount(makeProps())
    const before = findButton(container).style
    const boxBefore = {
      width: before.width,
      height: before.height,
      padding: before.padding,
      margin: before.margin,
      borderWidth: before.borderWidth,
    }

    await act(async () => { findButton(container).click() })

    const after = findButton(container).style
    // 状态变了（data-armed），但盒子尺寸五项必须逐项一致 —— 只有颜色可变。
    expect(findButton(container).getAttribute('data-armed')).toBe('true')
    expect({
      width: after.width,
      height: after.height,
      padding: after.padding,
      margin: after.margin,
      borderWidth: after.borderWidth,
    }).toEqual(boxBefore)
    await act(async () => { root.unmount() })
  })

  it('悬停时图标颜色由 tertiary 转为 primary（与自带按钮一致）', async () => {
    const { container, root, act } = await mount(makeProps())
    const button = findButton(container)
    // 常态：外层 tertiary，内层 inherit。
    expect(button.style.color).toContain('label-tertiary')

    await act(async () => {
      button.dispatchEvent(new globalThis.window.MouseEvent('mouseover', { bubbles: true }))
    })
    // 悬停：颜色提升到**内层 span**（图标继承它）。
    const inner = findButton(container).querySelector('span')
    expect(inner.style.color).toContain('label-primary')
    await act(async () => { root.unmount() })
  })

  it('⚠️ 上膛后图标变红（用户要求的确认态视觉）', async () => {
    const { container, root, act } = await mount(makeProps())
    // 常态不是红色。
    expect(findButton(container).style.color).toContain('label-tertiary')

    await act(async () => { findButton(container).click() })

    // 上膛：外层转 error 色，svg 用 currentColor 继承 → 图标变红。
    expect(findButton(container).style.color).toContain('state-error-primary')
    expect(findButton(container).getAttribute('data-armed')).toBe('true')
    // 图标仍是同一枚（没有换成别的图形）。
    expect(findButton(container).querySelectorAll('svg path')).toHaveLength(5)
    await act(async () => { root.unmount() })
  })

  it('失败态也用红色（提示用户可重试）', async () => {
    const props = makeProps({
      rpcCall: vi.fn(async () => { throw new Error('会话正在运行') }),
    })
    const { container, root, act } = await mount(props)
    await act(async () => { findButton(container).click() })
    await act(async () => { findButton(container).click() })

    expect(findButton(container).style.color).toContain('state-error-primary')
    expect(findButton(container).getAttribute('data-failed')).toBe('true')
    await act(async () => { root.unmount() })
  })
})

describe('两段式确认', () => {
  it('⚠️ 第一次点击只进入确认态，**不发删除请求**', async () => {
    const props = makeProps()
    const { container, root, act } = await mount(props)

    await act(async () => { findButton(container).click() })

    // 进入确认态（图标变红，data-armed 置位）。
    expect(findButton(container).getAttribute('data-armed')).toBe('true')
    // 关键：还没有发出任何删除请求。
    expect(props.rpcCall).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })

  it('第二次点击才真的调用 archive.delete', async () => {
    const props = makeProps()
    const { container, root, act } = await mount(props)

    await act(async () => { findButton(container).click() })
    await act(async () => { findButton(container).click() })

    expect(props.rpcCall).toHaveBeenCalledTimes(1)
    expect(props.rpcCall).toHaveBeenCalledWith('archive.delete', { sessionId: A })
    await act(async () => { root.unmount() })
  })

  it('删除失败后回到未上膛状态并标记可重试', async () => {
    const props = makeProps({
      rpcCall: vi.fn(async () => { throw new Error('会话正在运行') }),
    })
    const { container, root, act } = await mount(props)

    await act(async () => { findButton(container).click() })
    await act(async () => { findButton(container).click() })

    expect(props.rpcCall).toHaveBeenCalledTimes(1)
    expect(findButton(container).getAttribute('data-failed')).toBe('true')
    expect(findButton(container).getAttribute('title')).toContain('重试')
    await act(async () => { root.unmount() })
  })

  it('失焦取消确认态，再次点击需要重新上膛', async () => {
    const props = makeProps()
    const { container, root, act } = await mount(props)

    await act(async () => { findButton(container).click() })
    expect(findButton(container).getAttribute('data-armed')).toBe('true')

    // ⚠️ React 17+ 把 `onBlur` 映射到 **`focusout`**（冒泡版），
    // 直接派发不冒泡的 `blur` 不会触发 React 的合成事件。
    // 这里用真实焦点变化：先聚焦再 blur，jsdom 会派发 focusout。
    await act(async () => {
      findButton(container).focus()
      findButton(container).blur()
    })
    expect(findButton(container).getAttribute('data-armed')).toBeNull()
    // 失焦后单点不应删除。
    await act(async () => { findButton(container).click() })
    expect(props.rpcCall).not.toHaveBeenCalled()
    await act(async () => { root.unmount() })
  })

  it('点击不会冒泡到会话行（避免顺带打开该会话）', async () => {
    const props = makeProps()
    const { container, root, act, dom } = await mount(props)
    // ⚠️ 监听必须挂在**比 React 根容器更外层**的节点上。
    // 挂在 container 上只能验证「同一元素的其他监听器」，
    // 而 React 17+ 的根监听器就在 container 上 —— 那样的断言恒为真。
    const bubbled = []
    dom.window.document.body.addEventListener('click', () => bubbled.push(1))

    await act(async () => { findButton(container).click() })
    expect(bubbled).toHaveLength(0)
    await act(async () => { root.unmount() })
  })
})

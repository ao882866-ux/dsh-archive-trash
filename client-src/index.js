/**
 * 归档会话删除按钮（客户端入口）—— 挂在侧栏会话行的悬停按钮条上。
 *
 * ## 落点选择
 *
 * `sidebar.workspaces.session.row.action`：DSH 自己把「归档/取消归档」按钮注册在
 * 这里（id `archive`，order 100），所以本插件的删除按钮与它并排出现，语义连贯
 * —— 归档的旁边就是删归档的。
 *
 * （早期版本还有一个独立的「设置 → 归档会话」页面与一个回收站面板，均已按用户
 * 要求移除：前者与 DSH 原生的「仅显示已归档」筛选重复，后者用户明确不需要。）
 *
 * ⚠️ **只在会话已归档时才渲染按钮**。归档状态从 `ctx.workspaces.list` 快照的
 * `archivedSessionIds` 读（DSH 自己的 `archiveInjected` 也是这么做的：
 * `derive(workspaces.list, s => new Set(s.archivedSessionIds))`）。
 * 不加这个判断的话，每个普通会话行上都会出现「删除」，误删风险极高。
 *
 * 宿主侧仍**独立复核**归档状态 —— 客户端判断只是「按钮该不该出现」，
 * 不能当作安全边界（伪造请求可绕过）。
 */

export const name = 'session-archive-client'
export const inject = ['slots', 'connection']

import * as React from 'react'
import { DeleteArchivedSessionButton } from './delete-button.js'

const CHANNEL = 'session-archive'

/**
 * 调用宿主端点。
 *
 * 失败必须**抛错**而不是返回 undefined —— 否则界面会把「请求失败」当成
 * 「删除成功」，用户以为删掉了、实际没有。
 */
async function callRpc(connection, method, payload, signal) {
  const result = await connection.rpc.call('/api', CHANNEL, { method, payload }, signal)
  if (result?.ok === true) return result.value
  if (result?.ok === false) {
    const error = new Error(result.error?.message || '归档管理请求失败')
    error.code = result.error?.code
    throw error
  }
  return result
}

export function apply(ctx) {
  const rpcCall = (method, payload, signal) => callRpc(ctx.connection, method, payload, signal)

  /**
   * 已归档会话集合。
   *
   * 从 `ctx.workspaces.list` 快照派生 —— 这是 DSH 自己在会话行上判断
   * 「该显示归档还是取消归档按钮」用的同一份数据，因此不会出现
   * 「DSH 认为已归档、本插件认为没有」的错位。
   *
   * `ctx.workspaces` 可能不存在（非 Web profile / 服务未装载），此时
   * 返回空集合 → 不渲染按钮。宁可不显示，也不误显示。
   */
  function archivedSetSnapshot() {
    const workspaces = ctx.get?.('workspaces')
    const snapshot = workspaces?.list?.getSnapshot?.()
    const ids = snapshot?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids : [])
  }

  ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.row.action',
    id: 'session-archive-delete',
    // 排在 DSH 自带的 archive(100) 与 pin(200) 之后。
    order: 300,
    inject: () => ({ rpcCall, archivedSetSnapshot }),
  }, DeleteArchivedSessionButton))
}

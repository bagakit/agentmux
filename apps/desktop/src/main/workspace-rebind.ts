import { dirname } from 'node:path'
import type { AppConfig, WorkspaceRecord } from '../shared/contracts.js'
import { isFolderWorkspace } from '../shared/contracts.js'

/**
 * 把一个本地文件夹 Workspace 重新指向另一个目录：问用户选哪个目录，然后只换那一条记录的 path。
 *
 * 这一段此前长在 `registerIpc` 内部的 handler 里，而它唯一的守卫是 workspace-navigation-wiring
 * 的 `readFileSync` + `toContain('item.id === workspaceId ? updated : item')` 一族。文本断言看不见
 * 这段代码有没有被执行到：在 handler 第一行插一句 `return null`，整个重绑对用户**永久失效**
 * （点了"重新指定目录"永不更新路径），而那 2 条断言全绿（实测；死代码里那些字符串照旧存在）。
 * handler 长在 registerIpc 的闭包里，本仓没有任何测试 import 得到它。
 *
 * 用户取消对话框与"用户选了目录"必须分开：前者返回 null 且**一个字节都不落盘**，后者才写。
 * 把这两条折在一起，取消一次就会把 config 重写一遍（内容相同但触发 Runtime prepare/commit）。
 */
export type RebindPorts = {
  /** 弹目录选择器。`defaultPath` 落在当前路径的父目录——用户要找的是那个"搬走了的"目录。 */
  chooseDirectory(defaultPath: string): Promise<{ canceled: boolean; filePaths: string[] }>
  /** 走 Runtime 事务写 config，失败要能把已准备的 Runtime 回收掉。 */
  save(next: AppConfig): Promise<AppConfig>
}

export async function rebindLocalFolder(
  workspaceId: string,
  config: AppConfig,
  ports: RebindPorts
): Promise<{ config: AppConfig; workspace: WorkspaceRecord | null }> {
  const current = config.workspaces.find((item) => item.id === workspaceId)
  if (!current) throw new Error(`Unknown workspace: ${workspaceId}`)
  if (current.hostId !== 'local' || !isFolderWorkspace(current)) {
    throw new Error('Only local folder Workspaces can be rebound')
  }
  const selection = await ports.chooseDirectory(dirname(current.path))
  const path = selection.filePaths[0]
  // 取消：原样交还 config，不写盘。
  if (selection.canceled || !path) return { config, workspace: null }
  // Workspace 的 id 与用户看到的名字保持不变。Session、布局与 Provider 身份都以那个 id 为键，
  // 变的只有文件系统定位符。
  const updated: WorkspaceRecord = { ...current, path }
  const next = await ports.save({
    ...config,
    workspaces: config.workspaces.map((item) => (item.id === workspaceId ? updated : item))
  })
  return { config: next, workspace: next.workspaces.find((item) => item.id === workspaceId) ?? updated }
}

// ---------------------------------------------------------------------------
// 每一跳都在——但"这一层存在"证明不了"这一层跑得到"。实测：在 ipc.ts 的 rebindLocalFolder
// handler 第一行插一句 `return null`，重绑对用户永久失效（点了"重新指定目录"永不更新路径），
// 而这里 2 条全绿（死代码里那些字符串照旧存在）。编排因此搬进了 workspace-rebind，由
// workspace-rebind.test.ts 真跑；这个文件只剩"每一跳都在"这一件事。
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('Workspace rebind is wired through the desktop boundary', () => {
  it('declares the verb in contracts and preload', () => {
    expect(read('../src/shared/contracts.ts')).toContain('rebindLocalFolder(workspaceId: string)')
    expect(read('../src/preload/index.ts')).toContain("'workspaces:rebindLocalFolder'")
  })

  it('updates the existing record in main and exposes a preview implementation', () => {
    const ipc = read('../src/main/ipc.ts')
    expect(ipc).toContain("handle('workspaces:rebindLocalFolder'")
    // 重绑的编排**不在** ipc.ts：它在 workspace-rebind 里，因为 handler 长在 registerIpc 的
    // 闭包里，本仓没有任何测试 import 得到它。handler 现在只转发。
    expect(ipc).toContain('./workspace-rebind.js')
    expect(read('../src/renderer/src/lib/api.ts')).toContain('rebindLocalFolder: async () => null')
  })
})

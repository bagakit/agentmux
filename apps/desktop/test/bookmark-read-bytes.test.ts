import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts.js'
import { WorkspaceFiles } from '../src/main/workspace-files.js'

/**
 * `readBookmarkBytes` 的**远端**分支：远端 host 的 `run` 只给 utf8 解码后的 string
 * （`process-runner.ts:16/78`），二进制 plist 经它往返必坏。所以远端只支持文本形态的书签，
 * 二进制（含 NUL）**显式返回 null**——诚实地说「取不回」，而不是交出一份类型合法、内容已坏的
 * `Uint8Array`（那会让下游白跑一次 `plutil`，并把通路缺陷伪装成坏文件）。
 *
 * 两条一起才守得住：
 *  - 负例：远端 stdout 含 NUL → null（删掉 `isBinaryContent` 那行会让这条翻红——变异判据）。
 *  - 正例：远端 `.url`（纯文本）→ 返回可解析的字节。没有正例的话「一律 null」也能骗过负例。
 */

function remoteHostReturning(stdout: string): { host: ExecutionHost; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn<ExecutionHost['run']>(async (command, args) => {
    if (command === 'realpath') return { stdout: `${String(args.at(-1))}\n`, stderr: '', exitCode: 0 }
    if (command === 'sh') return { stdout, stderr: '', exitCode: 0 }
    throw new Error(`Unexpected command: ${command}`)
  })
  return {
    run,
    host: { id: 'remote', kind: 'ssh', label: 'Remote', run, exposeLoopbackPort: async (p) => p, dispose: async () => {} }
  }
}

const workspace: WorkspaceRecord = {
  id: 'remote-workspace',
  name: 'project',
  hostId: 'remote',
  path: '/srv/project',
  kind: 'folder'
}

const NUL = String.fromCharCode(0)

describe('readBookmarkBytes remote branch never hands out corrupted bytes', () => {
  it('remote stdout containing NUL (a decoded binary plist) resolves to null, not a broken Uint8Array', async () => {
    // 远端 cat 一个二进制 .webloc：host 把它 utf8 解码成 string，NUL 存活在串里。
    const { host, run } = remoteHostReturning(`bplist00${NUL}corrupted`)
    const files = new WorkspaceFiles(() => host)
    await expect(files.readBookmarkBytes(workspace, 'links/Binary.webloc')).resolves.toBeNull()
    // 它确实走到了远端读一步（不是路径判定就短路了），否则这条与被测通路无关。
    expect(run).toHaveBeenCalled()
  })

  it('remote text bookmark (.url) returns bytes that decode back to the exact content', async () => {
    const text = '[InternetShortcut]\nURL=https://example.com/\n'
    const { host } = remoteHostReturning(text)
    const files = new WorkspaceFiles(() => host)
    const bytes = await files.readBookmarkBytes(workspace, 'links/Site.url')
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes!)).toBe(text)
  })
})

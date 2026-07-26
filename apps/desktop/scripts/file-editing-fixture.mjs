import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// SSOT for the mounted file-editing E2E fixture. Both the ship gate (package-macos.mjs, which mounts the
// signed .app through LaunchServices) and the fast dev runner (probe-file-editing.mjs, which launches the
// built main directly) materialize the SAME userData config + workspace trees here. A forked copy would
// drift, and "green in the fast runner" would stop meaning "green in the package gate" — the shared module
// is the whole reason the fast loop is trustworthy.
//
// 这个模块只能保证【两个调用方造出同一份 fixture】。它**保证不了**这份 fixture 与 src/ 那边的期望一致，
// 因为 scripts/*.mjs 与 src/*.ts 不在同一个构建图里，导不了同一个符号。下面两处耦合各自靠什么兜底，
// 写清楚，别让人误以为有静态检查：
//
//   - workspace id：与 src/main/index.ts:182-183 的字面量必须一致。改错了不会静默——index.ts:184
//     查不到就抛 'requires its primary and alternate mounted workspaces'，报告不落盘、两个门禁全红。
//   - version: 7：与 src/main/config-store.ts 的 z.literal(7) 必须一致。schema 升到 8 而这里忘了改，
//     ConfigStore 会走 isOlderVersion 分支删掉配置、回落到空 workspaces，同样在 index.ts:184 炸掉。
//
// 两处都是响亮失败、不是假绿，但报错都指不到这里——改 schema 或改 id 时记得回来同步。
export const FILE_EDITING_PRIMARY_WORKSPACE_ID = 'workspace-file-editing-e2e'
export const FILE_EDITING_ALTERNATE_WORKSPACE_ID = 'workspace-file-editing-alternate-e2e'

/**
 * Create the file-editing probe's userData config and both workspace trees exactly as the probe expects.
 * Directories are created first, then the files that live inside them — the same two-phase ordering the
 * packaging path has always used. Byte-for-byte identical output is the contract; do not diverge here.
 *
 * @param {{ userData: string; workspace: string; alternateWorkspace: string }} paths
 */
export async function materializeFileEditingFixture({ userData, workspace, alternateWorkspace }) {
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(workspace, 'explorer-source'), { recursive: true }),
    mkdir(join(workspace, 'targets', 'valid'), { recursive: true }),
    mkdir(join(workspace, 'targets', 'collision'), { recursive: true }),
    mkdir(join(workspace, 'targets', 'menu'), { recursive: true }),
    mkdir(join(workspace, 'targets', 'hover'), { recursive: true }),
    mkdir(join(workspace, 'targets', 'cancel'), { recursive: true }),
    mkdir(alternateWorkspace, { recursive: true })
  ])
  await Promise.all([
    writeFile(join(workspace, 'revision-probe.txt'), 'alpha', { mode: 0o640 }),
    writeFile(join(workspace, 'explorer-source', 'drag-valid.txt'), 'pointer move'),
    writeFile(join(workspace, 'explorer-source', 'drag-invalid.txt'), 'must stay put'),
    writeFile(join(workspace, 'explorer-source', 'menu.txt'), 'menu move'),
    writeFile(join(workspace, 'explorer-source', 'menu-neighbor.txt'), 'selection neighbor'),
    writeFile(join(workspace, 'targets', 'collision', 'drag-invalid.txt'), 'collision owner'),
    writeFile(join(workspace, 'targets', 'hover', 'child.txt'), 'hover child'),
    writeFile(join(workspace, 'targets', 'cancel', 'child.txt'), 'cancel child'),
    writeFile(join(alternateWorkspace, 'alternate.txt'), 'alternate workspace'),
    writeFile(join(userData, 'agentmux.config.json'), `${JSON.stringify({
      version: 7,
      hosts: [{ id: 'local', kind: 'local', label: 'Mounted Desktop E2E' }],
      executors: {},
      workspaces: [{
        id: FILE_EDITING_PRIMARY_WORKSPACE_ID,
        name: 'Workspace File Editing E2E',
        hostId: 'local',
        path: workspace,
        kind: 'folder'
      }, {
        id: FILE_EDITING_ALTERNATE_WORKSPACE_ID,
        name: 'Workspace File Editing Alternate E2E',
        hostId: 'local',
        path: alternateWorkspace,
        kind: 'folder'
      }],
      appearance: { terminalTheme: 'graphite' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
    }, null, 2)}\n`, { mode: 0o600 })
  ])
}

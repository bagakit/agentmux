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
//   - version：与 src/shared/contracts.ts 的 CONFIG_VERSION 必须一致。这条**曾经真的漏过**：
//     CONFIG_VERSION 从 7 升到 8 时这里没跟上，ConfigStore 走 isOlderVersion 分支删掉配置、回落到
//     空 workspaces，两个门禁都变红——而 `pnpm check`（test:fast + test:native）跑不到这两个门禁，
//     所以 2058 条测试全绿掩盖了它。这条现在由 test/config-fixture-version.test.ts 守：它扫描每个
//     往 agentmux.config.json 写配置的脚本，把字面量与 CONFIG_VERSION 对比，在 pnpm check 里就红。
//     那道门比这两个门禁快几个数量级，所以别只靠"跑一次打包"来发现漂移。
//
// workspace id 那条仍然只有"响亮失败"兜底，报错指不到这里——改 index.ts 的 id 时记得回来同步。
// version 那条现在有测试守，不必再靠跑门禁发现。
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
      version: 9,
      hosts: [{ id: 'local', kind: 'local', label: 'Mounted Desktop E2E' }],
      executors: {
        codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false }
      },
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

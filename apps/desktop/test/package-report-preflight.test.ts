import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatPackageReportPreflightError,
  inspectPackageReportPaths,
  PACKAGE_REPORT_NEXT_COMMAND
} from '../scripts/package-report-preflight.mjs'

const roots: string[] = []

/**
 * 被测脚本所在的 package 根（apps/desktop），**从本文件位置推出**而不是取 process.cwd()。
 *
 * 为什么必须这样（#647）：第一条用例要 spawn `scripts/report-desktop-package.mjs` 并检查它对「候选不
 * 存在」的报错。原先用 process.cwd() 拼路径，于是这条用例的通过与否取决于**在哪个目录发起 vitest**：
 * 在 apps/desktop 下跑是绿的，在仓库根跑时 cwd 里既没有那个脚本也没有 release/，node 直接报「找不到
 * 模块」，断言 stderr 里那句 preflight 措辞必然落空——实测仓库根 `Tests 1 failed | 2 passed (3)`。
 * 判据不该取决于调用者站在哪里（记忆 probe-must-not-bet-on-startup-landing 的同族：探针的被测对象必须
 * 由探针自己确定）。
 */
const DESKTOP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 造出一份齐全的候选：目录用 mkdir -p，可执行文件与 DMG 用空文件——preflight 只问在不在，不读内容。 */
async function materializeAllArtifacts(paths: {
  appPath: string
  rendererAssets: string
  mainExecutablePath: string
  dmgPath: string
}): Promise<void> {
  await mkdir(paths.rendererAssets, { recursive: true })
  await mkdir(dirname(paths.mainExecutablePath), { recursive: true })
  await writeFile(paths.mainExecutablePath, '')
  await writeFile(paths.dmgPath, '')
}

/** 一组指向 root 之下的候选路径，形状与 report-desktop-package.mjs 真正传进来的那份一致。 */
function artifactPathsUnder(root: string): {
  appPath: string
  rendererAssets: string
  mainExecutablePath: string
  dmgPath: string
} {
  const appPath = join(root, 'release', 'mac', 'AgentMux.app')
  return {
    appPath,
    rendererAssets: join(appPath, 'Contents', 'Resources', 'app', 'out', 'renderer', 'assets'),
    mainExecutablePath: join(appPath, 'Contents', 'MacOS', 'AgentMux'),
    dmgPath: join(root, 'release', 'mac', 'AgentMux-0.1.0-darwin-arm64.dmg')
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('package report preflight', () => {
  it('package report command has a clean-build smoke path when no candidate exists', async () => {
    const candidate = join(DESKTOP_ROOT, 'release', 'mac', 'AgentMux.app')
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['scripts/report-desktop-package.mjs'], {
        cwd: DESKTOP_ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
    if (await stat(candidate).then(() => true, () => false)) {
      expect(result.code, result.stderr).not.toBe(1)
      return
    }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`missing release candidate at ${candidate}`)
    expect(result.stderr).toContain(`Run \`${PACKAGE_REPORT_NEXT_COMMAND}\``)
    expect(result.stderr).not.toContain('ENOENT')
    expect(result.stdout).not.toContain('Error: ENOENT')
  })

  it('returns an actionable diagnostic instead of exposing an ENOENT stack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-report-'))
    roots.push(root)
    const paths = {
      appPath: join(root, 'release', 'mac', 'AgentMux.app'),
      rendererAssets: join(root, 'release', 'mac', 'AgentMux.app', 'Contents', 'Resources', 'app', 'out', 'renderer', 'assets'),
      mainExecutablePath: join(root, 'release', 'mac', 'AgentMux.app', 'Contents', 'MacOS', 'AgentMux'),
      dmgPath: join(root, 'release', 'mac', 'AgentMux-0.1.0-darwin-arm64.dmg')
    }

    const result = await inspectPackageReportPaths(paths)
    expect(result.ok).toBe(false)
    const diagnostic = formatPackageReportPreflightError(result.missing)
    expect(diagnostic).toContain(`missing release candidate at ${paths.appPath}`)
    expect(diagnostic).toContain(`Run \`${PACKAGE_REPORT_NEXT_COMMAND}\``)
    expect(diagnostic).not.toContain('ENOENT')
    expect(diagnostic).not.toContain('at async')
  })

  it('checks every release artifact when the bundle directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-report-complete-'))
    roots.push(root)
    const appPath = join(root, 'AgentMux.app')
    const paths = {
      appPath,
      rendererAssets: join(appPath, 'Contents', 'Resources', 'app', 'out', 'renderer', 'assets'),
      mainExecutablePath: join(appPath, 'Contents', 'MacOS', 'AgentMux'),
      dmgPath: join(root, 'AgentMux.dmg')
    }
    const result = await inspectPackageReportPaths(paths)
    expect(result.ok).toBe(false)
    expect(result.missing.map(({ label }) => label)).toEqual([
      'release candidate',
      'renderer assets',
      'main executable',
      'DMG'
    ])
  })

  // 以下两条是这道门的**另一侧**（#646）。上面三条构造的全是「四个都不在」的世界，于是把实现改成
  // `const missing = [...required]`（无条件全报缺）三条全绿——门对「候选其实齐全」这一侧完全失明，
  // 而那正是它每次成功打包时都要走的那条路：一旦恒报缺，report 永远起不来。
  // 判据要成对：一条钉「全在场 ⇒ ok」，一条钉「只缺一个 ⇒ 恰好报那一个」（记忆 guard-count-exits-not-conditions：
  // && 的「接受」侧常无人守）。
  it('reports ok with no missing entries when every artifact is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-report-present-'))
    roots.push(root)
    const paths = artifactPathsUnder(root)
    await materializeAllArtifacts(paths)

    const result = await inspectPackageReportPaths(paths)
    // 前提自证：这四条路径必须真的落地了，否则下面的 ok===true 是在为一个空世界背书。
    for (const path of Object.values(paths)) {
      expect(await stat(path).then(() => true, () => false), `fixture 没造出 ${path}`).toBe(true)
    }
    expect(result.missing, '候选齐全时仍报了缺失项——无条件报缺会让每次成功打包都拿不到 report').toEqual([])
    expect(result.ok, '四个产物都在场却 ok=false').toBe(true)
  })

  it('names only the one absent artifact when the rest are present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-report-partial-'))
    roots.push(root)
    const paths = artifactPathsUnder(root)
    await materializeAllArtifacts(paths)
    // 只把 DMG 拿掉：app、renderer assets、main executable 三个仍在场。
    await rm(paths.dmgPath)

    const result = await inspectPackageReportPaths(paths)
    expect(result.ok).toBe(false)
    // 恰好一个，且就是 DMG。写成 toEqual 而非 toContain：多报（无条件全报缺）与少报都要红。
    expect(
      result.missing.map(({ label }) => label),
      '部分缺失时报的不是「恰好那一个」——多报说明判定没看在场性，少报说明漏检'
    ).toEqual(['DMG'])
    // 诊断文案也要只提这一个，不能把在场的产物一起说成缺失。
    const diagnostic = formatPackageReportPreflightError(result.missing)
    expect(diagnostic).toContain(`missing DMG at ${paths.dmgPath}`)
    expect(diagnostic, '诊断把在场的 release candidate 也说成缺失').not.toContain('missing release candidate')
  })
})

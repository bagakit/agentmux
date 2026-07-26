import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  foregroundActionsForSecondInstance,
  instanceRoleFromLock
} from '../src/main/single-instance.js'

/**
 * Wiring guard for the main-process window + startup setup. The pure projections (window-geometry.ts,
 * single-instance.ts) are unit tested directly, but the *call site* in index.ts cannot be imported
 * (its module runs Electron app side effects on load). Reverting the constructor to the fixed literal,
 * dropping persistence, or removing the single-instance guard would leave every pure test green while
 * regressing the feature, so this scans index.ts source for the load-bearing wiring.
 *
 * Comments are stripped first and every assertion anchors on a code shape a comment cannot supply.
 */

const here = dirname(fileURLToPath(import.meta.url))
const indexPath = join(here, '../src/main/index.ts')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('main window setup wiring', () => {
  it('drives the BrowserWindow size from persisted geometry, not the fixed literal', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    // The scan must actually find the constructor — an empty read must not pass silently.
    expect(source).toContain('new BrowserWindow(')
    // The persisted geometry is spread into the constructor options.
    expect(source).toContain('...windowConstructorGeometry(persistedGeometry)')
    // The fixed literal must be gone from code (it survives only in a comment, which is stripped).
    expect(source).not.toMatch(/width:\s*1480/)
    expect(source).not.toMatch(/height:\s*940/)
  })

  it('registers the window-state persistence owner (geometry capture + unload flush)', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    expect(source).toContain('registerWindowStatePersistence(window, windowGeometryStore)')
  })

  it('binds development and packaged launches to the same durable userData root', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    expect(source).toContain("app.setPath('userData', process.env.AGENTMUX_DESKTOP_USER_DATA ?? packagedUserDataPath)")
    expect(source).not.toMatch(/else\s+if\s*\(app\.isPackaged\)/)
  })

  it('routes all window creation through the single-flight guard so triggers cannot race into two windows', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    // 建窗必须经单飞去重，否则 whenReady/second-instance/activate 会在空档里并发建出两个窗口。
    expect(source).toContain('const createWindow = singleFlight(buildWindow)')
    // 三处触发点都调 createWindow（被去重的那个），而不是直接调裸的 buildWindow。
    expect(source).not.toMatch(/void buildWindow\(\)/)
    expect(source).toContain('await createWindow(appReadyAtMs)')
  })

  it('installs the custom application menu so Cmd+W is not stolen by the native close-window role', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    // 默认菜单把 Cmd+W 绑到关窗口，原生加速键渲染层 preventDefault 拦不住——必须换成自建的、不绑
    // Cmd+W 的菜单。删掉这句接线，Cmd+W 关格在 mac 上会退化成关掉整个窗口（数据丢失）。
    expect(source).toContain('applicationMenuTemplate(')
    expect(source).toContain('Menu.setApplicationMenu(')
    expect(source).toContain('Menu.buildFromTemplate(')
    // 平台位喂进去：mac 与非 mac 的 File/Window 段不同。
    expect(source).toMatch(/applicationMenuTemplate\(\s*process\.platform === 'darwin'\s*\)/)
  })
})

describe('single-instance guard: pure decisions', () => {
  it('holding the lock makes us primary', () => {
    expect(instanceRoleFromLock(true)).toEqual({ role: 'primary' })
  })

  it('failing to get the lock makes us a secondary', () => {
    // secondary 只是角色判别；退出走接线层的 app.quit()（默认码 0），角色数据里不再带退出码。
    expect(instanceRoleFromLock(false)).toEqual({ role: 'secondary' })
  })

  it('a live minimized window is restored then focused — never a no-op', () => {
    // 顺序有意义：先还原再聚焦，否则聚焦一个最小化窗口用户还是看不见。
    expect(foregroundActionsForSecondInstance({ exists: true, minimized: true })).toEqual([
      'restore',
      'focus'
    ])
  })

  it('a live non-minimized window is just focused', () => {
    expect(foregroundActionsForSecondInstance({ exists: true, minimized: false })).toEqual(['focus'])
  })

  it('with no window (macOS app alive, all closed) it creates one — the second click must do something', () => {
    expect(foregroundActionsForSecondInstance({ exists: false, minimized: false })).toEqual(['create'])
  })
})

describe('single-instance guard: index.ts wiring', () => {
  it('acquires the lock and quits the secondary before constructing any runtime owner', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    expect(source.length).toBeGreaterThan(0)
    // 守卫必须调用官方单实例锁，并把结果喂给纯决策函数。
    expect(source).toContain('instanceRoleFromLock(app.requestSingleInstanceLock())')
    // 第二实例判定后必须真的退出——app.quit() 必须落在 secondary 分支体内（分支体不含其它花括号，
    // 所以 [^}]* 不会跨出分支去误命中文件里别处的 app.quit()）。删掉这句退出会红。
    expect(source).toMatch(/=== 'secondary'\)[^}]*\{[^}]*app\.quit\(\)/)

    // 关键顺序：拿锁/退出必须发生在 new RuntimeController 之前。晚一步就已经踩上会话存储和 daemon。
    const lockAt = source.indexOf('requestSingleInstanceLock')
    const runtimeAt = source.indexOf('new RuntimeController(')
    expect(lockAt).toBeGreaterThan(0)
    expect(runtimeAt).toBeGreaterThan(0)
    expect(lockAt).toBeLessThan(runtimeAt)
  })

  it('runtime owners are constructed only inside the primary-instance path', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    // RuntimeController 必须在 startPrimaryInstance 里构造，第二实例连碰都碰不到。
    expect(source).toContain('function startPrimaryInstance(')
    const primaryAt = source.indexOf('function startPrimaryInstance(')
    const runtimeAt = source.indexOf('new RuntimeController(')
    expect(primaryAt).toBeGreaterThan(0)
    expect(runtimeAt).toBeGreaterThan(primaryAt)
  })

  it('handles second-instance by bringing the existing window to the foreground', async () => {
    const source = stripComments(await readFile(indexPath, 'utf8'))
    expect(source).toContain("app.on('second-instance'")
    expect(source).toContain('foregroundActionsForSecondInstance(')
  })
})

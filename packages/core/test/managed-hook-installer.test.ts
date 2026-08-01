import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { BUILT_IN_AGENT_PROVIDERS, resolveManagedHookPlan } from '../src/agent-provider.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true })
  }))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-hook-installer-'))
  directories.push(directory)
  const stateDirectory = join(directory, 'state')
  const existingPath = join(directory, 'provider', 'hooks.json')
  const createdPath = join(directory, 'provider', 'agentmux-hook.sh')
  await mkdir(join(directory, 'provider'), { recursive: true })
  await writeFile(existingPath, '{"user":true}\n', { mode: 0o640 })
  return {
    installer: new AgentManagedHookInstaller(stateDirectory),
    existingPath,
    createdPath
  }
}

describe('explicit managed Hook installation', () => {
  it('previews exact files, installs once, and restores the previous generation on uninstall', async () => {
    const { installer, existingPath, createdPath } = await fixture()
    const preview = await installer.preview({
      providerId: 'codex',
      mutations: [
        { path: existingPath, content: '{"user":true,"agentmux":true}\n' },
        { path: createdPath, content: '#!/bin/sh\nexit 0\n', mode: 0o700 }
      ]
    })
    expect(preview.changes).toMatchObject([
      { path: existingPath, action: 'replace' },
      { path: createdPath, action: 'create' }
    ])
    expect(await readFile(existingPath, 'utf8')).toBe('{"user":true}\n')

    const receipt = await installer.install(preview.id)
    expect(await readFile(existingPath, 'utf8')).toBe('{"user":true,"agentmux":true}\n')
    expect((await stat(createdPath)).mode & 0o777).toBe(0o700)
    expect(receipt.entries[0]?.backupPath).not.toBeNull()

    await installer.uninstall(receipt)
    expect(await readFile(existingPath, 'utf8')).toBe('{"user":true}\n')
    await expect(stat(createdPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when a target changes after preview or after install', async () => {
    const { installer, existingPath } = await fixture()
    const stalePreview = await installer.preview({
      providerId: 'claude',
      mutations: [{ path: existingPath, content: '{"agentmux":1}\n' }]
    })
    await writeFile(existingPath, '{"user-edited":1}\n')
    await expect(installer.install(stalePreview.id)).rejects.toMatchObject({ code: 'HOOK_TARGET_CHANGED' })
    expect(await readFile(existingPath, 'utf8')).toBe('{"user-edited":1}\n')

    const currentPreview = await installer.preview({
      providerId: 'claude',
      mutations: [{ path: existingPath, content: '{"agentmux":2}\n' }]
    })
    const receipt = await installer.install(currentPreview.id)
    await writeFile(existingPath, '{"user-edited-after-install":1}\n')
    await expect(installer.uninstall(receipt)).rejects.toMatchObject({ code: 'HOOK_TARGET_CHANGED' })
    expect(await readFile(existingPath, 'utf8')).toBe('{"user-edited-after-install":1}\n')
  })

  it.runIf(process.platform !== 'win32')('rejects a receipt whose backup escapes the state directory through a symlink', async () => {
    const { installer, existingPath } = await fixture()
    const preview = await installer.preview({
      providerId: 'codex',
      mutations: [{ path: existingPath, content: '{"agentmux":true}\n' }]
    })
    const receipt = await installer.install(preview.id)
    const originalBackup = receipt.entries[0]?.backupPath
    if (!originalBackup) throw new Error('fixture did not create a recovery backup')
    const outsideBackup = join(dirname(dirname(dirname(dirname(originalBackup)))), 'outside.backup')
    await writeFile(outsideBackup, '{"user":true}\n')
    await rm(originalBackup)
    await symlink(outsideBackup, originalBackup)

    await expect(installer.uninstall(receipt)).rejects.toMatchObject({ code: 'INVALID_HOOK_RECEIPT' })
    expect(await readFile(existingPath, 'utf8')).toBe('{"agentmux":true}\n')
  })

  it('merges into a shared config, preserving foreign keys through install and uninstall', async () => {
    const { installer, existingPath } = await fixture()
    // A shared ~/.gemini-style file the real CLI also writes into.
    await writeFile(existingPath, `${JSON.stringify({ 'user-hooks': { Stop: ['keep-me'] } }, null, 2)}\n`)
    const preview = await installer.preview({
      providerId: 'antigravity',
      mutations: [{
        path: existingPath,
        content: `${JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })}\n`,
        merge: { kind: 'json-owned-key', key: 'agentmux-status' }
      }]
    })
    expect(preview.changes[0]?.action).toBe('replace')

    const receipt = await installer.install(preview.id)
    const installed = JSON.parse(await readFile(existingPath, 'utf8'))
    expect(installed['user-hooks']).toEqual({ Stop: ['keep-me'] })
    expect(installed['agentmux-status']).toBeDefined()

    await installer.uninstall(receipt)
    // Uninstall restores the exact pre-install file — the foreign key is intact, our key is gone.
    const restored = JSON.parse(await readFile(existingPath, 'utf8'))
    expect(restored['user-hooks']).toEqual({ Stop: ['keep-me'] })
    expect(restored['agentmux-status']).toBeUndefined()
  })

  it('is idempotent on reinstall over an already-merged shared config', async () => {
    const { installer, existingPath } = await fixture()
    await writeFile(existingPath, `${JSON.stringify({ other: 1 }, null, 2)}\n`)
    const mutation = {
      path: existingPath,
      content: `${JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })}\n`,
      merge: { kind: 'json-owned-key', key: 'agentmux-status' } as const
    }
    await installer.install((await installer.preview({ providerId: 'antigravity', mutations: [mutation] })).id)
    const afterFirst = await readFile(existingPath, 'utf8')
    // Second preview over the already-merged file must report unchanged (no accumulation, no rewrite).
    const secondPreview = await installer.preview({ providerId: 'antigravity', mutations: [mutation] })
    expect(secondPreview.changes[0]?.action).toBe('unchanged')
    await installer.install(secondPreview.id)
    expect(await readFile(existingPath, 'utf8')).toBe(afterFirst)
  })

  it('ensure() installs once then no-ops on relaunch (install-and-leave)', async () => {
    const { installer, existingPath } = await fixture()
    await writeFile(existingPath, `${JSON.stringify({ other: 1 }, null, 2)}\n`)
    const plan = {
      providerId: 'antigravity' as const,
      mutations: [{
        path: existingPath,
        content: `${JSON.stringify({ 'agentmux-status': { PreToolUse: [{ command: 'agentmux-hook.js' }] } })}\n`,
        merge: { kind: 'json-owned-key', key: 'agentmux-status' } as const
      }]
    }
    // First launch: a write happens, so a receipt is returned and the foreign key is preserved.
    const firstReceipt = await installer.ensure(plan)
    expect(firstReceipt).not.toBeNull()
    const installed = JSON.parse(await readFile(existingPath, 'utf8'))
    expect(installed['other']).toBe(1)
    expect(installed['agentmux-status']).toBeDefined()
    const afterFirst = await readFile(existingPath, 'utf8')
    // Every subsequent launch: nothing to do, so ensure() returns null and never touches disk.
    expect(await installer.ensure(plan)).toBeNull()
    expect(await installer.ensure(plan)).toBeNull()
    expect(await readFile(existingPath, 'utf8')).toBe(afterFirst)
  })

  // 上面那条 install-and-leave 靠的是「内容 hash 未变 ⇒ 无需重写」。那条判据把一个契约压在了
  // **计划构造侧**：同一个 workspace 解析出的计划内容必须恒定，绝不能含真实时钟。踩中它的后果有两个，
  // 都不响亮：每次启动都重写一遍用户的 hooks 配置；以及 preview 与 install 两次渲染结果不一致而撞上
  // HOOK_TARGET_CHANGED——启动照旧成功（install 失败是 best-effort，只发一条 agent-error），
  // 用户拿到的是一个没有状态 hook 的 Agent。
  //
  // 这条契约今天每一家都成立，但只有 cursor 一家在注释里说过（它专门为此把 trust marker 的时间戳
  // 从 `new Date()` 换成 workspace 路径 hash 派生的稳定纪元偏移）。其余各家全靠作者自觉，没人守。
  // 所以这里逐家判——不抽样：判「分布性质」时抽一对可能恰好落在盲点上。
  //
  // 判据不是「两次调用相等」（同一毫秒内 `new Date()` 也相等，那样是恒真），而是**把系统时钟拨过去
  // 一年半再调一次**仍相等。任何 Date.now()/new Date() 的使用都会在这里露出来。
  it('每个 explicit-managed Provider 的计划内容对同一 workspace 恒定——不含真实时钟', () => {
    const managed = BUILT_IN_AGENT_PROVIDERS.filter(
      (provider) =>
        provider.catalog.hookStrategy.kind === 'native' &&
        provider.catalog.hookStrategy.installation === 'explicit-managed'
    )
    // 挡板：这一族读成空则下面循环一条不跑、整条静默通过。11 家是当前实际家数
    // （九家写命令 + pi/opencode 两家写投递代码）。
    expect(managed.length).toBeGreaterThanOrEqual(11)

    const workspacePath = '/tmp/agentmux-plan-stability'
    // 每次都给 endpoint：写**投递代码**的那一族（opencode 的 JS 插件跑在 OpenCode 自己的进程里，
    // 读不到 AgentMux 注入 PTY 的环境变量）没有 endpoint 时会如实弃权返回 null——那是刻意设计，
    // 内联一个死 token 比不装更坏。不给 endpoint 的话它在这里是 null，而本条要守的是**恒定性**，
    // 不该因为「这一家在缺 endpoint 时弃权」就把它从恒定性判据里漏掉。
    // endpoint 本身必须逐次相同，否则内容里内联的 url/token 会跟着变，把本条判成不恒定。
    const endpoint = { url: 'http://127.0.0.1:65535/hook', token: 'stable-token' }
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
      const before = Date.now()
      const first = managed.map((provider) => resolveManagedHookPlan(provider.id, workspacePath, {}, endpoint))

      vi.setSystemTime(new Date('2025-07-04T12:34:56.789Z'))
      // 挡板：假时钟必须真的动了。若 vitest 某天不再伪造 Date，上面两次取值会相同，
      // 这条判据就退化成「同一时刻调两次」——恒真。让那种失明响亮变红。
      expect(Date.now()).toBeGreaterThan(before)
      const second = managed.map((provider) => resolveManagedHookPlan(provider.id, workspacePath, {}, endpoint))

      for (const [index, provider] of managed.entries()) {
        // 声明了 explicit-managed 就必须真能解析出计划：解析器表漏一家会在这里露出来，
        // 而不是被下面的「相等」判据当成 null === null 混过去。
        expect(first[index], `${provider.id} declares explicit-managed but resolves no plan`).not.toBeNull()
        expect(second[index], `${provider.id} plan is unstable across a clock change`).toEqual(first[index])
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

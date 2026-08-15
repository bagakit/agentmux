import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAgentRoleBindings, registerAgentRole, resolveAgentRole } from '../src/agent-role-directory.js'
import { AgentMuxError } from '../src/errors.js'

const rolesFile = (root: string) => join(root, '.agents', 'agentmux-roles.json')

async function workspaceWithRoles(...roles: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'amx-role-'))
  for (const role of roles) {
    await registerAgentRole({ role, agentSessionId: `s-${role}`, workspacePath: root, providerId: 'codex' })
  }
  return root
}

describe('agent role directory',()=>{it('registers and resolves exact live workspace binding',async()=>{const root=await mkdtemp(join(tmpdir(),'amx-role-'));const b=await registerAgentRole({role:'maintainer',agentSessionId:'s1',workspacePath:root,providerId:'codex'});expect(b.role).toBe('maintainer');expect(await resolveAgentRole({workspacePath:root,role:'maintainer',sessionExists:async id=>id==='s1'})).toEqual(b);expect(await readFile(join(root,'.agents','agentmux-roles.json'),'utf8')).toContain('s1')});it('does not resolve stale or duplicate target',async()=>{const root=await mkdtemp(join(tmpdir(),'amx-role-'));await registerAgentRole({role:'maintainer',agentSessionId:'s1',workspacePath:root,providerId:'codex'});expect(await resolveAgentRole({workspacePath:root,role:'maintainer',sessionExists:async()=>false})).toBeNull()})})

describe('角色目录读不出来时不许当成「一条都没有」', () => {
  it('文件不存在 → 空表，这是真话', async () => {
    // 这一条是另一条的对照面。两者必须给出**不同**的结果，否则「区分缺席与损坏」这个性质
    // 根本不可观测——把整个 ENOENT 分支删掉改成一律抛，这条会红。
    const root = await mkdtemp(join(tmpdir(), 'amx-role-'))
    expect(await readAgentRoleBindings(root)).toEqual([])
  })

  it('文件在但 JSON 坏了 → 抛，不是空表', async () => {
    const root = await workspaceWithRoles('maintainer')
    await writeFile(rolesFile(root), '{ this is not json')
    await expect(readAgentRoleBindings(root)).rejects.toThrow(AgentMuxError)
  })

  it('顶层不是数组 → 同样抛：`{}` 不是一张空的登记表', async () => {
    // 这一条单独存在，是因为它此前走的不是 catch 而是那个 `: []` 三元分支——即使给 catch 补上
    // 了抛出，它仍会静默变成空表。两条路要分别钉住。
    const root = await workspaceWithRoles('maintainer')
    await writeFile(rolesFile(root), '{}')
    await expect(readAgentRoleBindings(root)).rejects.toThrow(/not a list of bindings/)
  })

  it('读不出来时 register 拒绝写盘——否则它拿空表当全量，把别人的登记全覆盖掉', async () => {
    // 这是这组用例真正要买的那个性质，其余几条都是它的前提。
    //
    // 实测过的坏世界（`readAgentRoleBindings` 用 `catch { return [] }` 时）：登记 maintainer 与
    // reviewer，损坏文件，再登记 tester —— 盘上只剩 `['tester']`，另外两条没有任何痕迹地消失。
    // 判据因此落在**盘上的字节**，不落在抛不抛：抛出只是手段，不丢数据才是目的。
    const root = await workspaceWithRoles('maintainer', 'reviewer')
    const corrupt = '{ this is not json'
    await writeFile(rolesFile(root), corrupt)

    await expect(
      registerAgentRole({ role: 'tester', agentSessionId: 's-tester', workspacePath: root, providerId: 'codex' })
    ).rejects.toThrow(AgentMuxError)

    expect(
      await readFile(rolesFile(root), 'utf8'),
      '损坏的角色目录被这次 register 覆盖了——原来的两条绑定已经没了'
    ).toBe(corrupt)
  })

  it('resolve 对「读不出来」抛而不是返回 null——null 的意思是「没人认领这个角色」', async () => {
    // 两个世界的区别全在 CLI 那一句话上：`resolve` 返回 null 时 agentmux.ts:184 抛的是
    // `MAINTAINER_TARGET_UNRESOLVED`（「这个角色没人认领」），而真相是「我根本没能去看」。
    // 一句指错方向的错误比没有错误更贵——用户会去登记一个其实已经登记过的角色。
    const root = await workspaceWithRoles('maintainer')
    await writeFile(rolesFile(root), '{ this is not json')
    await expect(
      resolveAgentRole({ workspacePath: root, role: 'maintainer', sessionExists: async () => true })
    ).rejects.toThrow(AgentMuxError)
  })

  it('单条记录不合规仍然只跳过那一条——宽松与严格的分界是「还能不能安全重写这个文件」', async () => {
    // 反向的一半：上面几条要求「读不出来就别写」，这一条要求那个严格**不要扩散**到单条校验。
    // 文件读得出、结构对，只是某条记录带了空字段；为它整体拒读会让一条坏记录锁死整个角色目录，
    // 而丢掉它不损失任何别的绑定。没有这一条，把 filter 改成「有坏记录就抛」也照样全绿。
    const root = await workspaceWithRoles('maintainer')
    const bindings = JSON.parse(await readFile(rolesFile(root), 'utf8'))
    await writeFile(rolesFile(root), JSON.stringify([...bindings, { role: '', agentSessionId: 'x', workspacePath: root, providerId: 'codex' }]))

    expect((await readAgentRoleBindings(root)).map((binding) => binding.role)).toEqual(['maintainer'])
  })
})

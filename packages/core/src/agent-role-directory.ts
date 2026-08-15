import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError } from './errors.js'

export type AgentRoleBinding = { role: string; agentSessionId: string; workspacePath: string; providerId: string; registeredAt: number }
const file = (workspacePath: string) => join(workspacePath, '.agents', 'agentmux-roles.json')
function valid(value: string): boolean { return Boolean(value && !/[\0\r\n]/u.test(value)) }

/**
 * 读出这个 Workspace 登记过的角色绑定。**「文件不存在」与「文件读不出来」是两件事。**
 *
 * 不存在 → `[]`，这是真话：还没有人登记过任何角色。
 * 存在但读不出来（JSON 坏了、EACCES、磁盘错误）→ 抛。这里曾经是一句 `catch { return [] }`，
 * 把两者压成同一个答案，而 `registerAgentRole` 拿那个 `[]` 当「当前全量」去写盘：
 *
 *   实测（临时目录）：先登记 maintainer 与 reviewer，把文件内容改成非法 JSON，再登记 tester
 *   —— 落盘结果是 `['tester']`，另外两条**静默消失**，没有日志也没有报错。
 *
 * 这正是本仓记过的 silent-degradation 形态：降级不抛就打开了写闸。`config-store.ts` 对同一个问题
 * 早有答案（:831 起，ENOENT 走默认、其余一律抛并且把原字节留档），这里采用同一条分界，而不是
 * 再发明一种读法。
 *
 * 抛出对三个调用方都是正确的：`roles register` 宁可失败也不该吃掉别人的登记；`roles list` 报
 * 「读不出来」比报「一条都没有」诚实；`resolveAgentRole` 此前把读失败变成 `null`，于是 CLI 报
 * `MAINTAINER_TARGET_UNRESOLVED`——那句话说的是「没人认领这个角色」，而真相是「我没能去看」。
 */
export async function readAgentRoleBindings(workspacePath: string): Promise<AgentRoleBinding[]> {
  let text: string
  try {
    text = await readFile(file(workspacePath), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new AgentMuxError(
      `Agent role directory is unreadable: ${file(workspacePath)}`,
      'AGENT_ROLE_DIRECTORY_UNREADABLE',
      error instanceof Error ? error.message : String(error)
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new AgentMuxError(
      `Agent role directory is not valid JSON: ${file(workspacePath)}`,
      'AGENT_ROLE_DIRECTORY_UNREADABLE',
      error instanceof Error ? error.message : String(error)
    )
  }
  // 顶层不是数组 → 同样是「这个文件不是我能读的东西」，与 JSON 语法错误同一档。此前它走
  // `: []` 那一支，于是一个 `{}` 会和坏 JSON 一样被当成空登记表，接着被覆盖掉。
  if (!Array.isArray(parsed)) {
    throw new AgentMuxError(
      `Agent role directory is not a list of bindings: ${file(workspacePath)}`,
      'AGENT_ROLE_DIRECTORY_UNREADABLE'
    )
  }
  // 单条不合规则跳过——这一层**保持宽松**是有意的，与上面几条不同：文件读得出、结构对，只是
  // 某一条记录带了空字段或控制字符。丢掉那一条不会损失别的绑定，而为它整体拒读会让一条坏记录
  // 锁死整个角色目录。分界线是「我还能不能安全地重写这个文件」：能，就继续。
  return parsed.filter((x) => x && valid(x.role) && valid(x.agentSessionId) && valid(x.workspacePath) && valid(x.providerId))
}

export async function registerAgentRole(input: Omit<AgentRoleBinding, 'registeredAt'>): Promise<AgentRoleBinding> {
  if (![input.role,input.agentSessionId,input.workspacePath,input.providerId].every(valid)) throw new Error('Invalid Agent role binding')
  // 读不出来就不写：下面这行写的是 `[...replaced, next]`，也就是**全量覆盖**，所以 `current`
  // 必须是真正的当前全量。让上面那个函数抛，是这条写入路径唯一的保护。
  const current = await readAgentRoleBindings(input.workspacePath)
  const next = { ...input, registeredAt: Date.now() }
  const replaced = current.filter((x) => x.role !== input.role)
  const directory = join(input.workspacePath, '.agents'); await mkdir(directory, { recursive: true })
  const temp = join(directory, `.agentmux-roles.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temp, JSON.stringify([...replaced, next], null, 2) + '\n', { mode: 0o600 }); await rename(temp, file(input.workspacePath)); return next
}
export async function resolveAgentRole(input: { workspacePath: string; role: string; sessionExists: (id: string) => Promise<boolean> }): Promise<AgentRoleBinding | null> {
  const candidates = (await readAgentRoleBindings(input.workspacePath)).filter((x) => x.role === input.role && x.workspacePath === input.workspacePath)
  if (candidates.length !== 1 || !(await input.sessionExists(candidates[0]!.agentSessionId))) return null
  return candidates[0]!
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AgentRoleBinding = { role: string; agentSessionId: string; workspacePath: string; providerId: string; registeredAt: number }
const file = (workspacePath: string) => join(workspacePath, '.agents', 'agentmux-roles.json')
function valid(value: string): boolean { return Boolean(value && !/[\0\r\n]/u.test(value)) }
export async function readAgentRoleBindings(workspacePath: string): Promise<AgentRoleBinding[]> {
  try { const parsed = JSON.parse(await readFile(file(workspacePath), 'utf8')); return Array.isArray(parsed) ? parsed.filter((x) => x && valid(x.role) && valid(x.agentSessionId) && valid(x.workspacePath) && valid(x.providerId)) : [] } catch { return [] }
}
export async function registerAgentRole(input: Omit<AgentRoleBinding, 'registeredAt'>): Promise<AgentRoleBinding> {
  if (![input.role,input.agentSessionId,input.workspacePath,input.providerId].every(valid)) throw new Error('Invalid Agent role binding')
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

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerAgentRole, resolveAgentRole } from '../src/agent-role-directory.js'
describe('agent role directory',()=>{it('registers and resolves exact live workspace binding',async()=>{const root=await mkdtemp(join(tmpdir(),'amx-role-'));const b=await registerAgentRole({role:'maintainer',agentSessionId:'s1',workspacePath:root,providerId:'codex'});expect(b.role).toBe('maintainer');expect(await resolveAgentRole({workspacePath:root,role:'maintainer',sessionExists:async id=>id==='s1'})).toEqual(b);expect(await readFile(join(root,'.agents','agentmux-roles.json'),'utf8')).toContain('s1')});it('does not resolve stale or duplicate target',async()=>{const root=await mkdtemp(join(tmpdir(),'amx-role-'));await registerAgentRole({role:'maintainer',agentSessionId:'s1',workspacePath:root,providerId:'codex'});expect(await resolveAgentRole({workspacePath:root,role:'maintainer',sessionExists:async()=>false})).toBeNull()})})

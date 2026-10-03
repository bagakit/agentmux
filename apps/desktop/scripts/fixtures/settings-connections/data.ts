import { fixturePath as _hygiene_fixturePath, fixtureTime as _hygiene_fixtureTime } from "../../lib/fixture-values.mjs"
import type { AgentMuxRpcResult } from '@agentmux/core'
import type { AppConfig } from '../../../src/shared/contracts'

export function connectionsConfig(before: AppConfig): AppConfig {
  return { ...before,
    hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }, ...Array.from({ length: 23 }, (_, index) => ({
      id: `host-${String(index + 1).padStart(2, '0')}`, kind: 'ssh' as const,
      label: index < 2 ? 'Development' : `Remote ${String(index + 1).padStart(2, '0')}`,
      hostname: `controlled-${index + 1}.invalid`, user: 'developer', port: 2222,
      identityFile: '~/.ssh/controlled key', remoteCommand: (_hygiene_fixturePath("opt/agentmux") + " --literal"),
      remoteSocketPath: _hygiene_fixturePath("srv/literal.sock"), runtimeId: 'controlled-bound-runtime'
    }))],
    workspaces: [
      { id: 'project-a', name: 'Application on A', kind: 'folder', hostId: 'host-01', path: _hygiene_fixturePath("controlled/shared") },
      { id: 'project-b', name: 'Library on A', kind: 'folder', hostId: 'host-01', path: _hygiene_fixturePath("controlled/library") },
      { id: 'project-c', name: 'Application on B', kind: 'folder', hostId: 'host-02', path: _hygiene_fixturePath("controlled/shared") }
    ]
  }
}

/** Exact original DTO; controlled facts are not OS approval or connectivity proof. */
export const deviceList: AgentMuxRpcResult<'device.ls'> = {
  hostId: 'controlled-mac',
  devices: [{ deviceId: 'controlled-phone', name: 'Personal phone', createdAt: _hygiene_fixtureTime(-67225600000) }],
  mobileAccess: { state: 'unavailable', message: 'Controlled connection observation. Existing Sessions remain available.' }
}
export const deviceInvitation: AgentMuxRpcResult<'device.link'> = { hostId: deviceList.hostId, url: 'http://192.168.1.20:8443/#offer=controlled-preview' }

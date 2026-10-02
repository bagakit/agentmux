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

const previewExpiration = _hygiene_fixtureTime(100 * 365 * 24 * 60 * 60 * 1000)

/** Exact original DTO; controlled facts are not OS approval or connectivity proof. */
export const deviceList: AgentMuxRpcResult<'device.ls'> = {
  hostId: 'controlled-mac',
  devices: [{ deviceId: 'controlled-phone', name: 'Personal phone', createdAt: _hygiene_fixtureTime(-67225600000) }],
  requests: [{ device: { deviceId: 'controlled-tablet', name: 'New tablet', createdAt: _hygiene_fixtureTime(-67225600000) },
    confirmationCode: '654321', expiresAt: previewExpiration }],
  privateAccess: { state: 'unavailable',
    message: 'Controlled observation: the original Mac has not confirmed its private HTTPS entry. ' +
      'Keep existing Agents and devices. Prepare the certificate and original launch manifest, then explicitly verify phone reachability. ' +
      'Reading this page does not install certificates, grant device access or restart the service.',
    configurationPath: _hygiene_fixturePath("controlled/host-launch.json"),
    certificatePreparation: { executable: _hygiene_fixturePath("controlled/electron"), entry: _hygiene_fixturePath("controlled/prepare-certificate.mjs"), electronRunAsNode: true }
  }
}

export const deviceInvitation: AgentMuxRpcResult<'device.invite'> = {
  hostId: deviceList.hostId, invitation: 'CONTROLLED-PREVIEW-ONLY', expiresAt: previewExpiration
}

import { describe, expect, it } from 'vitest'
import { buildAgentMuxSshArgs } from '../src/ssh-daemon-connector.js'

describe('AgentMux system SSH transport argv', () => {
  it('keeps local SSH options separate from one quoted remote connect command', () => {
    const args = buildAgentMuxSshArgs({
      target: {
        hostId: 'buildbox',
        hostname: 'dev.example.com',
        user: 'river',
        port: 2222,
        identityFile: '/keys/dev key',
        extraArgs: ['-o', 'IdentitiesOnly=yes']
      },
      remoteNodePath: '/opt/node with space/bin/node',
      remoteAgentMuxdPath: '/home/river/.agentmux/versions/build one/package/dist/agentmuxd.js',
      remoteSocketPath: '/home/river/.agentmux/agentmuxd.sock',
      expectedBuildIdentity: 'build one'
    })

    expect(args.slice(0, -2)).toEqual([
      '-T',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-p',
      '2222',
      '-i',
      '/keys/dev key',
      '-o',
      'IdentitiesOnly=yes',
      '--'
    ])
    expect(args.at(-2)).toBe('river@dev.example.com')
    expect(args.at(-1)).toContain("'/opt/node with space/bin/node'")
    expect(args.at(-1)).toContain("'/home/river/.agentmux/versions/build one/package/dist/agentmuxd.js'")
    expect(args.at(-1)).toContain(' connect ')
  })

  it('rejects unsafe destinations before system SSH starts', () => {
    expect(() => buildAgentMuxSshArgs({
      target: { hostId: 'bad-host', hostname: 'host name' },
      remoteNodePath: 'node',
      remoteAgentMuxdPath: '/tmp/agentmuxd.js',
      remoteSocketPath: '/tmp/agentmuxd.sock',
      expectedBuildIdentity: 'build-1'
    })).toThrowError('SSH target contains unsupported characters')
  })
})

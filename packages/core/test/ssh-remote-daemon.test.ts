import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxSshRemoteDaemon } from '../src/ssh-remote-daemon.js'
import type { ProcessRunner } from '../src/process-runner.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, {
    recursive: true,
    force: true
  })))
})

async function artifactPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agentmux-remote-unit-'))
  directories.push(directory)
  const path = join(directory, 'artifact.tgz')
  await writeFile(path, 'fixture')
  return path
}

describe('AgentMux SSH remote management boundaries', () => {
  it('rejects an unsupported remote platform with an actionable code', async () => {
    const localRunner = vi.fn<ProcessRunner>().mockResolvedValue({
      stdout: './agentmux-artifact.json\n',
      stderr: '',
      exitCode: 0
    })
    const sshRunner = vi.fn<ProcessRunner>().mockResolvedValue({
      stdout: JSON.stringify({ home: '/home/river', platform: 'win32', arch: 'x64' }),
      stderr: '',
      exitCode: 0
    })
    const remote = new AgentMuxSshRemoteDaemon({
      target: { hostId: 'windows-host', hostname: 'windows.example' },
      localRunner,
      sshRunner
    })
    await expect(remote.install({
      archivePath: await artifactPath(),
      buildIdentity: 'build-1',
      platform: 'linux-x64'
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_REMOTE_PLATFORM' })
  })

  it('rejects archive traversal before opening an SSH install stream', async () => {
    const localRunner = vi.fn<ProcessRunner>().mockResolvedValue({
      stdout: '../escape\n',
      stderr: '',
      exitCode: 0
    })
    const sshRunner = vi.fn<ProcessRunner>()
    const remote = new AgentMuxSshRemoteDaemon({
      target: { hostId: 'linux-host', hostname: 'linux.example' },
      localRunner,
      sshRunner
    })
    await expect(remote.install({
      archivePath: await artifactPath(),
      buildIdentity: 'build-1',
      platform: 'linux-x64'
    })).rejects.toMatchObject({ code: 'INVALID_REMOTE_ARTIFACT' })
    expect(sshRunner).not.toHaveBeenCalled()
  })

  it('refuses forged uninstall layouts outside the managed .agentmux directory', () => {
    const remote = new AgentMuxSshRemoteDaemon({
      target: { hostId: 'linux-host', hostname: 'linux.example' }
    })
    expect(() => remote.createClient({
      hostId: 'linux-host',
      buildIdentity: 'build-1',
      platform: 'linux-x64',
      remoteBaseDirectory: '/tmp/not-agentmux',
      remoteAgentMuxdPath: '/tmp/not-agentmux/versions/build-1/package/dist/agentmuxd.js',
      remoteSocketPath: '/tmp/not-agentmux/agentmuxd.sock',
      remoteStatePath: '/tmp/not-agentmux/agentmuxd.sock.sessions.json'
    })).toThrowError('outside the managed AgentMux layout')
  })
})

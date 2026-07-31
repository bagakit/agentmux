import { describe, expect, it } from 'vitest'
import {
  AgentProviderRegistry,
  resolveManagedHookPlan,
  type AgentProvider
} from '../src/agent-provider.js'

function resumeContext(provider: AgentProvider) {
  return {
    workspacePath: '/tmp/agentmux-provider-conformance',
    nativeHandle: {
      kind: 'provider' as const,
      providerId: provider.id,
      sessionId: `native-${provider.id}`,
      transcriptPath: `/tmp/agentmux-provider-conformance/${provider.id}.jsonl`
    },
    args: [] as string[],
    env: {}
  }
}

describe('built-in Provider conformance', () => {
  const registry = new AgentProviderRegistry()
  const providers = registry.list()

  it('enumerates a non-empty registry with one module-backed implementation per id', () => {
    expect(providers.length).toBeGreaterThan(0)
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length)
    for (const provider of providers) {
      expect(provider.catalog.id).toBe(provider.id)
      expect(provider.catalog.label).toBe(provider.label)
      expect(provider.catalog.executable).toBe(provider.executable)
      expect(provider.catalog.readySignal).toEqual({
        kind: 'foreground-process',
        expectedProcess: provider.catalog.expectedProcess
      })
    }
  })

  it('keeps capability declarations consistent with hook strategy and managed installation', () => {
    for (const provider of providers) {
      const { capabilities, hookStrategy } = provider.catalog
      const managedPlan = resolveManagedHookPlan(
        provider.id,
        '/tmp/agentmux-provider-conformance',
        { HERMES_HOME: '/tmp/agentmux-provider-conformance/hermes' }
      )

      expect(capabilities.hookEvents).toBe(hookStrategy.kind === 'native')
      if (hookStrategy.kind === 'none') {
        expect(managedPlan).toBeNull()
        expect(capabilities.timeline).toBe('unavailable')
        expect(capabilities.permission).toBe('none')
      } else if (hookStrategy.installation === 'explicit-managed') {
        expect(managedPlan?.providerId).toBe(provider.id)
        expect(managedPlan?.mutations.length).toBeGreaterThan(0)
      } else {
        expect(managedPlan).toBeNull()
      }
    }
  })

  it('keeps providerResume capability and the actual resume method aligned', () => {
    for (const provider of providers) {
      const { capabilities, resumeStrategy } = provider.catalog
      expect(capabilities.providerResume).toBe(resumeStrategy.kind === 'provider-native')

      if (resumeStrategy.kind === 'none') {
        expect(() => provider.buildResumeLaunch(resumeContext(provider))).toThrow(/does not support provider-native resume/)
      } else {
        const launch = provider.buildResumeLaunch(resumeContext(provider))
        expect(launch.command).toBe(provider.executable)
        expect(launch.args.length).toBeGreaterThan(0)
        expect(launch.env).toEqual({})
      }
    }
  })

  it('projects the same declared capabilities from probing and catalog enumeration', async () => {
    for (const provider of providers) {
      const probed = await provider.probeCapabilities({ async hasExecutable() { return true } })
      expect(probed).toMatchObject({
        providerId: provider.id,
        executable: provider.executable,
        installed: true,
        capabilities: provider.catalog.capabilities
      })
    }
  })
})

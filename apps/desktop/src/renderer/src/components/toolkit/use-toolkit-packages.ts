import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolkitDescriptor, ToolkitToolConfiguration } from '@agentmux/core/control'
import { api } from '../../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'

export type ToolkitPackageDescriptor = Extract<ToolkitDescriptor, { kind: 'package' }>
export type ToolkitToolIdentity = { id: string; name: string; icon: string; enabled: boolean; statusBar: 'icon' | 'label' }

/** Manifest facts are transient observations. Source code and file facts never enter configuration. */
export function useToolkitPackages(tools: readonly ToolkitToolConfiguration[], active: boolean) {
  const [packages, setPackages] = useState<ReadonlyMap<string, ToolkitPackageDescriptor>>(new Map())
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const epoch = useRef(0), current = useRef(tools)
  current.current = tools
  const key = JSON.stringify(tools.flatMap(tool => 'kind' in tool ? [[tool.id, tool.revision, tool.packagePath]] : []))
  const refresh = useCallback(async () => {
    if (!active) return
    const generation = ++epoch.current
    if (!current.current.some(tool => 'kind' in tool)) { setPackages(new Map()); setError(''); setPending(false); return }
    setPending(true)
    try {
      const facts = await api.toolkit.list()
      if (generation !== epoch.current) return
      const accepted = new Map<string, ToolkitPackageDescriptor>()
      for (const fact of facts) if (fact.kind === 'package') {
        const tool = current.current.find(tool => tool.id === fact.toolId)
        if (tool && 'kind' in tool && tool.revision === fact.configRevision && tool.packagePath === fact.path) accepted.set(fact.toolId, fact)
      }
      setPackages(accepted); setError('')
    } catch (cause) { if (generation === epoch.current) setError(presentError(cause)) }
    finally { if (generation === epoch.current) setPending(false) }
  }, [active])
  useEffect(() => { void refresh(); return () => { ++epoch.current } }, [key, refresh])
  return { packages, error, pending, refresh }
}
export function packageFact(tool: ToolkitToolConfiguration, facts: ReadonlyMap<string, ToolkitPackageDescriptor>): ToolkitPackageDescriptor | undefined {
  if (!('kind' in tool)) return undefined
  const fact = facts.get(tool.id)
  return fact?.configRevision === tool.revision && fact.path === tool.packagePath ? fact : undefined
}
export function toolkitIdentity(tool: ToolkitToolConfiguration, facts: ReadonlyMap<string, ToolkitPackageDescriptor>): ToolkitToolIdentity {
  const fact = packageFact(tool, facts)
  return { id: tool.id, name: 'kind' in tool ? fact?.name ?? tool.id : tool.name, icon: 'kind' in tool ? fact?.icon ?? 'terminal' : tool.icon, enabled: tool.enabled, statusBar: tool.statusBar }
}

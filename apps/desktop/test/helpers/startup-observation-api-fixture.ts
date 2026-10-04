import type { AgentSessionHistoryDescriptor } from '@agentmux/core'
import type { AgentMuxDesktopApi, ProviderCatalogObservation, SessionHistorySourcesObservation } from '../../src/shared/contracts'

/** Preserve the strict default readers while exercising the typed startup receipts. */
export function providerCatalogReader(catalog: ProviderCatalogObservation['catalog'] = [], warnings: ProviderCatalogObservation['warnings'] = [], beforeRead?: () => void): AgentMuxDesktopApi['providers']['list'] {
  async function read(options: { observation: true }): Promise<ProviderCatalogObservation>
  async function read(): Promise<ProviderCatalogObservation['catalog']>
  async function read(options?: { observation: true }): Promise<ProviderCatalogObservation | ProviderCatalogObservation['catalog']> {
    beforeRead?.()
    return options ? { catalog, warnings } : catalog
  }
  return read
}

export function historySourcesReader(sources: AgentSessionHistoryDescriptor[] = [], warnings: SessionHistorySourcesObservation['warnings'] = []): AgentMuxDesktopApi['sessions']['historySources'] {
  async function read(options: { observation: true }): Promise<SessionHistorySourcesObservation>
  async function read(): Promise<AgentSessionHistoryDescriptor[]>
  async function read(options?: { observation: true }): Promise<SessionHistorySourcesObservation | AgentSessionHistoryDescriptor[]> {
    return options ? { sources, warnings } : sources
  }
  return read
}

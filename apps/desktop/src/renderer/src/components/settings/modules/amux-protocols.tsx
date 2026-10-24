import { AGENTMUX_PROTOCOL_CATALOG, type AgentMuxProtocolCatalogEntry } from '@agentmux/core/agent-message-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { SemanticIcon, semanticIconComponent } from '@agentmux/client-ui/icons'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { useMemo, useRef, useState, type RefObject } from 'react'
import type { SettingsModule } from '../settings-catalog'
import '../../../styles/settings-amux-protocols.css'

/** Examples use the real message reader without resolving fictional objects or user identities. */
function ProtocolExamples({ entry }: { entry: AgentMuxProtocolCatalogEntry }) {
  const host = useClientUiPlatform()
  const platform = useMemo(() => ({ ...host,
    renderMessageAvatar: () => <SemanticIcon name="object.document" size={13} aria-hidden="true" />,
    renderObjectLink: ({ uri, label }: { uri: string; label?: string }) => <code title={uri}>{label ?? uri}</code>
  }), [host])
  return <ClientUiProvider platform={platform}>
    {entry.examples.map((example, index) => <section key={index} className="amux-protocols__example" aria-label={example.label}>
      <h4>{example.label}</h4>
      <div className="amux-protocols__comparison">
      <div className="amux-protocols__wire"><span className="amux-protocols__preview-label">Original wire</span><pre>{example.wire}</pre></div>
      <div className="amux-protocols__rendered"><span className="amux-protocols__preview-label">Rendered message</span><div className="amux-protocols__preview" data-protocol-example={entry.id}>
        <ConversationMessage content={example.wire} speaker={{ role: 'human', id: 'protocol-example' }} name="Example input"
          messageId={`protocol-example:${entry.id}:${index}`} compact expandedContent />
      </div></div>
      </div>
    </section>)}
  </ClientUiProvider>
}

function ProtocolRow({ entry, active, rowRef }: { entry: AgentMuxProtocolCatalogEntry; active: boolean; rowRef?: RefObject<HTMLDetailsElement | null> | undefined }) {
  const [open, setOpen] = useState(false)
  return <details ref={rowRef} className="amux-protocols__row" data-settings-field={entry.id}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <SemanticIcon name="navigation.disclosure" size={13} aria-hidden="true" />
      <span><strong>{entry.title}</strong><code>{entry.form}</code></span>
    </summary>
    {open && active ? <div className="amux-protocols__body">
      <p className="amux-protocols__description">{entry.description}</p>
      <ProtocolExamples entry={entry} />
    </div> : null}
  </details>
}

function AmuxProtocolsPane({ active }: { active: boolean }) {
  const firstExample = useRef<HTMLDetailsElement>(null)
  function openFirstExample() {
    if (!firstExample.current) return
    firstExample.current.open = true
    firstExample.current.querySelector('summary')?.focus()
  }
  return <div className="settings-pane-stack amux-protocols" aria-label="amux protocol reference">
    <div className="amux-protocols__intro"><p className="settings-group-note">Explore supported message formats and compare each rendered card with its original text. Examples are read-only and do not contact Agents, open links or execute protocol hints.</p><button type="button" className="small-button" onClick={openFirstExample}>View first example</button></div>
    <div className="amux-protocols__list">{AGENTMUX_PROTOCOL_CATALOG.map((entry, index) => <ProtocolRow key={entry.id} entry={entry} active={active} rowRef={index === 0 ? firstExample : undefined} />)}</div>
  </div>
}

export const amuxProtocolsSettingsModule = {
  id: 'amux-protocols',
  group: 'message-tool',
  title: 'amux Protocols',
  description: 'Readable formats, original wire examples, and shared message cards.',
  icon: semanticIconComponent('object.amux-protocols'),
  keywords: 'amux protocol protocols reference wire declaration envelope marker sharing links format card 协议 格式 声明 卡片 参考',
  searchTargets: AGENTMUX_PROTOCOL_CATALOG.map(entry => ({ id: entry.id, title: entry.title, description: entry.description,
    keywords: `${entry.id} ${entry.form} ${entry.examples.map(example => example.wire).join(' ')}`, kind: 'info' as const })),
  savedSummary: () => `${AGENTMUX_PROTOCOL_CATALOG.length} read-only formats`,
  Pane: AmuxProtocolsPane
} as const satisfies SettingsModule

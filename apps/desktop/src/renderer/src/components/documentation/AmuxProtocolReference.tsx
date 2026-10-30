import { AGENTMUX_PROTOCOL_CATALOG, type AgentMuxProtocolCatalogEntry } from '@agentmux/core/agent-message-render'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { TextInput } from '@agentmux/client-ui/input'
import { ClientUiProvider, useClientUiPlatform } from '@agentmux/client-ui/platform'
import { useMemo, useRef, useState, type RefObject } from 'react'
import './amux-protocol-reference.css'

/** Examples use the real reader without resolving fictional objects or user identities. */
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
  return <details ref={rowRef} className="amux-protocols__row" data-protocol-entry={entry.id} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><SemanticIcon name="navigation.disclosure" size={13} aria-hidden="true" /><span><strong>{entry.title}</strong><code>{entry.form}</code></span></summary>
    {open && active ? <div className="amux-protocols__body"><p className="amux-protocols__description">{entry.description}</p><ProtocolExamples entry={entry} /></div> : null}
  </details>
}

export function AmuxProtocolReference({ active }: { active: boolean }) {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null), firstExample = useRef<HTMLDetailsElement>(null)
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? AGENTMUX_PROTOCOL_CATALOG.filter(entry => `${entry.id} ${entry.title} ${entry.description} ${entry.form} ${entry.examples.map(example => `${example.label} ${example.wire}`).join(' ')}`.toLowerCase().includes(normalized)) : AGENTMUX_PROTOCOL_CATALOG
  }, [query])
  function openFirstExample() {
    if (!firstExample.current) return
    firstExample.current.open = true
    firstExample.current.querySelector('summary')?.focus()
  }
  return <section className="amux-protocols" aria-label="amux protocol reference">
    <div className="amux-protocols__toolbar">
      <label className="amux-protocols__search"><SemanticIcon name="action.search" size={15} aria-hidden="true" /><TextInput ref={search} data-documentation-search aria-label="Search amux Protocols" placeholder="Find a format or example…" value={query} onChange={event => setQuery(event.target.value)} />
        {query ? <button type="button" className="icon-button" aria-label="Clear documentation search" onClick={() => { setQuery(''); search.current?.focus() }}><SemanticIcon name="action.clear" size={13} /></button> : null}</label>
      <span className="amux-protocols__count" role="status">{visible.length === AGENTMUX_PROTOCOL_CATALOG.length ? `${visible.length} formats` : `${visible.length} of ${AGENTMUX_PROTOCOL_CATALOG.length} formats`}</span>
      {visible.length ? <button type="button" className="small-button" onClick={openFirstExample}>View first example</button> : null}
    </div>
    <p className="amux-protocols__read-only">Read-only examples do not contact Agents, open links or execute protocol hints.</p>
    <div className="amux-protocols__index">{visible.length ? <div className="amux-protocols__list">{visible.map((entry, index) => <ProtocolRow key={entry.id} entry={entry} active={active} rowRef={index === 0 ? firstExample : undefined} />)}</div>
      : <p className="amux-protocols__empty">No formats match “{query}”. Try a name, format or example text.</p>}</div>
  </section>
}

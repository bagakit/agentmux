import { AMUX_PROTOCOL_DEFINITIONS, AMUX_PROTOCOL_EXAMPLES, AMUX_PROTOCOL_TEMPLATES, type AMUX_PROTOCOL_PARAMETERS } from './generated/amux-protocols.js'

export { AMUX_PROTOCOL_DEFINITIONS }
export type AmuxProtocolId = keyof typeof AMUX_PROTOCOL_DEFINITIONS

type Template<Id extends AmuxProtocolId> = Extract<keyof typeof AMUX_PROTOCOL_TEMPLATES[Id], string>
type Slot<Id extends AmuxProtocolId, Variant extends Template<Id>> =
  Variant extends keyof typeof AMUX_PROTOCOL_PARAMETERS[Id]
    ? typeof AMUX_PROTOCOL_PARAMETERS[Id][Variant] extends readonly (infer Key)[] ? Extract<Key, string> : never
    : never
type Values = Readonly<Record<string, string>>
const definitions: Readonly<Record<AmuxProtocolId, Readonly<Record<string, string>>>> = AMUX_PROTOCOL_TEMPLATES

/** The unexpanded source template carried by this build. */
export function getAmuxProtocolTemplate<Id extends AmuxProtocolId, Variant extends Template<Id>>(id: Id, template: Variant): string {
  return definitions[id][template]!
}

function render(text: string, values: Values): string {
  return text.replace(/\{\{([a-z][a-zA-Z0-9]*)\}\}/gu, (_match, key: string) => {
    const value = values[key]
    if (typeof value !== 'string') throw new TypeError('Missing AMUX template parameter: ' + key)
    return value
  })
}

/** The formatter supplies encoded fields. Each value is substituted exactly once. */
export function renderAmuxProtocol<Id extends AmuxProtocolId, Variant extends Template<Id>>(id: Id, template: Variant,
  ...[values]: [Slot<Id, Variant>] extends [never] ? [values?: never] : [values: Readonly<Record<Slot<Id, Variant>, string>>]
): string {
  return render(getAmuxProtocolTemplate(id, template), values ?? {})
}

export type AgentMuxProtocolCatalogEntry = (typeof AMUX_PROTOCOL_DEFINITIONS)[AmuxProtocolId] & {
  id: AmuxProtocolId
  templates: readonly { name: string; text: string }[]
  examples: readonly { label: string; wire: string }[]
}

/** One compiled source for local discovery, examples and editable text. */
export const AGENTMUX_PROTOCOL_CATALOG: readonly AgentMuxProtocolCatalogEntry[] = /* @__PURE__ */
  (Object.keys(AMUX_PROTOCOL_DEFINITIONS) as AmuxProtocolId[]).map(id => ({
    id, ...AMUX_PROTOCOL_DEFINITIONS[id],
    templates: Object.entries(definitions[id]).map(([name, text]) => ({ name, text })),
    examples: AMUX_PROTOCOL_EXAMPLES[id].map(example => ({ label: example.label,
      wire: render(definitions[id][example.template]!, example.parameters) + ('after' in example ? example.after : '') }))
  }))

/** Matches the plain text encoder used by the readable XML envelopes. */
export function encodeAmuxText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;')
}

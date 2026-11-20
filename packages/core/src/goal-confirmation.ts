import { encodeAmuxText, getAmuxProtocolTemplate, renderAmuxProtocol } from './amux-protocol.js'
import { DOMImplementation, DOMParser, onWarningStopParsing, XMLSerializer } from '@xmldom/xmldom'
import { AMUX_PROTOCOL_DEFINITIONS } from './amux-protocol-definition.js'
import { parseAmuxObjectLink } from './sharing.js'

export type GoalConfirmation = { goalUrl: string; alignmentRevision: number; operationId: string }

const tag = AMUX_PROTOCOL_DEFINITIONS['goal-confirmation'].tag
const action = 'confirm-and-continue'
const frozenOpening = `<${tag} version="1" action="${action}">\n`
const closing = `\n</${tag}>`
const instruction = /* @__PURE__ */ getAmuxProtocolTemplate('goal-confirmation', 'instruction')

function assertGoalConfirmation({ goalUrl, alignmentRevision, operationId }: GoalConfirmation) {
  const target = parseAmuxObjectLink(goalUrl)
  if (target.kind !== 'goal' || !target.runtimeId || !target.namespace || target.section || target.nodeId ||
      !Number.isSafeInteger(alignmentRevision) || alignmentRevision < 1 ||
      typeof operationId !== 'string' || !operationId.trim() || operationId.includes('\0'))
    throw new TypeError('Goal continuation needs its exact original Goal address, confirmation revision and operation.')
}

/** Readers use the original Goal and Core receipts to establish authority and effects. */
export function formatGoalConfirmation(value: GoalConfirmation): string {
  return formatGoalConfirmationBody(value, instruction)
}

function formatGoalConfirmationBody(value: GoalConfirmation, body: string): string {
  assertGoalConfirmation(value)
  const document = new DOMImplementation().createDocument(null, '', null)
  const element = document.createElement(tag)
  element.setAttribute('goal', value.goalUrl)
  element.setAttribute('revision', String(value.alignmentRevision))
  element.setAttribute('operation-id', value.operationId)
  const attributes = new XMLSerializer().serializeToString(element).slice(tag.length + 2, -2)
  return renderAmuxProtocol('goal-confirmation', 'wire', { attributes, body: encodeAmuxText(body) })
}

export function parseGoalConfirmation(text: string): GoalConfirmation | null {
  if (!text.endsWith(closing)) return null
  try {
    if (text.startsWith(frozenOpening)) {
      // Existing input receipts keep and read their exact original wire.
      const body = text.slice(frozenOpening.length, -closing.length)
      const { goalUrl, alignmentRevision, operationId } = JSON.parse(body) as GoalConfirmation
      const original = { goalUrl, alignmentRevision, operationId }
      assertGoalConfirmation(original)
      const canonical = JSON.stringify(original)
        .replace(/[<>&]/gu, character => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[character]!)
      return body === canonical ? original : null
    }
    const header = /^<amux:goal version="2" action="confirm-and-continue"( goal="[^<>"\r\n]*" revision="[1-9]\d*" operation-id="[^<>"\r\n]*")>\n/u.exec(text)
    if (!header) return null
    const element = new DOMParser({ onError: onWarningStopParsing }).parseFromString(`<goal${header[1]}/>`, 'text/xml').documentElement!
    const value = { goalUrl: element.getAttribute('goal')!, alignmentRevision: Number(element.getAttribute('revision')), operationId: element.getAttribute('operation-id')! }
    const body = text.slice(header[0].length, -closing.length)
    if (body.includes('<')) return null
    const decoded = new DOMParser({ onError: onWarningStopParsing }).parseFromString('<body>' + body + '</body>', 'text/xml').documentElement?.textContent
    return typeof decoded === 'string' && formatGoalConfirmationBody(value, decoded) === text ? value : null
  } catch { return null }
}

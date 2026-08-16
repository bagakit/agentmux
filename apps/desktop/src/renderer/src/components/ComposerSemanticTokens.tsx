import { SemanticIcon } from './semantic-icons'
import type { ComposerSemanticReference } from '../lib/composer-semantic-reference'

export function ComposerSemanticTokens({
  references,
  onActivate
}: {
  references: readonly ComposerSemanticReference[]
  onActivate?: (reference: ComposerSemanticReference) => void
}) {
  if (references.length === 0) return null
  return <div className="composer__semantic-tokens" aria-label="Referenced tools">
    {references.map((reference) => <button
      type="button"
      className={`composer-semantic-token composer-semantic-token--${reference.kind}`}
      key={`${reference.kind}:${reference.token}`}
      title={reference.reference}
      onClick={() => onActivate?.(reference)}
    >
      <SemanticIcon name={reference.kind} size={11} />
      <span>{reference.label}</span>
    </button>)}
  </div>
}

import { Paperclip } from 'lucide-react'

export type ComposerReferenceToolProps = {
  disabled: boolean
  onSelect: (() => void) | undefined
  label: string
}

/** The host owns picking files and inserting references into its current draft. */
export function ComposerReferenceTool({ disabled, onSelect, label }: ComposerReferenceToolProps) {
  return (
    <button type="button" className="composer-tool" disabled={disabled || !onSelect}
      onClick={onSelect} aria-label={label} title={label}>
      <Paperclip size={14} /><span className="composer-tool__label">Files</span>
    </button>
  )
}

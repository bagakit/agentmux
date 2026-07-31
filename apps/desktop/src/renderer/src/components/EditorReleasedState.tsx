/**
 * The Monaco native editor/model can be disposed while its Region and document remain in the
 * Store. Returning to the Region mounts the same path/content again through EditorPane.
 */
export function EditorReleasedState() {
  return (
    <section className="surface-memory-released" role="status" aria-live="polite">
      <strong>Editor parked</strong>
      <span>Switch back to this tab to restore the editor.</span>
    </section>
  )
}

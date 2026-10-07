# Draft image removal scene

Uses the production InlineComposer, Tiptap node views, document codec, original image viewer and shared theme. A generated in-memory PNG and an explicit unreadable reference avoid user resources. Two nodes intentionally have the same path.

Trusted Enter removes only the first node, returns focus to the original editor and writes the exact remaining draft. The existing editor undo/redo restores/removes it. Historical and disabled references expose no removal control. The failed reference remains removable. Capture covers normal/narrow widths and both themes with a focused control.

The same scene includes landscape, portrait and square inline images beside text, using the production Composer owner and the collapsed AgentComposer. Real pointer input opens each preview; geometry and hit checks reject a trailing action column, clipped corner control or a removal target over adjacent text. Touch input precisely removes the original landscape and portrait references with their controls visible.

Behavior and presentation belong to docs/design/behavior/conversation-input.md and docs/design/presentation/conversation-input.md. Private profiles/build output are removed after the probe exits; no real Session, filesystem deletion or installed Host behavior is claimed. Final full frames need independent visual review.

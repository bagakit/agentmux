# Review: conversation message reading, copy and annotation

## Decision

Treat conversation turns as an editorial register. Human turns align to the right and use a restrained surface treatment; Agent turns stay left aligned without the old one-pixel rail or chat-card border. Every turn exposes Copy on hover/focus and copies the complete source text. Text selection opens an anchored annotation popover; submitting sends a structured quoted reference plus the user's note through the existing Agent composer/session path.

## Acceptance evidence

- ConversationMessage source and rendered behavior cover human/agent layout and message actions.
- Copy failure is surfaced without losing the message.
- Annotation preserves message id, quote and range, and can be inserted into the current Agent draft/send path.
- Block mutations make the targeted tests red; source scans prove production callers.

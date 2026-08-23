# Review: Leader Topic attached panel interaction

## Decision

Approved. The floating Leader Topic launcher and its open panel are one continuous surface. The dragon avatar is the primary toggle: click it to open, click it again to close. The more-actions control stays immediately beside the avatar and has an explicit accessible label.

## Constraints

- Opening and closing reuses the same fixed `launcher:leader` Topic and floating state.
- The panel must be visually attached to the launcher while open; it cannot remain as a distant independent window.
- Dragging the attached surface continues to move the persisted floating position.
- Compact placement keeps the avatar and more-actions control grouped with the bottom switcher.


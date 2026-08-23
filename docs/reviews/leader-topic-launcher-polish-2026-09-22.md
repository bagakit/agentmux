# Review: Leader Topic launcher polish and anchored opening

## Decision

Approved. Put the more-actions control over the dragon badge, replace the green outline with a translucent frosted surface, make the floating click path explicitly toggle the same open state, and anchor compact-mode opening near the bottom launcher.

## Constraints

- One avatar remains the only primary open/close control.
- The more-actions button stays a separate hit target and does not trigger open/close.
- Floating and compact placement share the same fixed Topic and state; only the panel anchor differs.
- Clamping must keep the panel fully visible inside the viewport.


# PTY size authority

Status: approved. Authority: user requested fixing wrong Resume size after recent ctxmux size integration, and explicitly requested best-effort parallel work on this accepted pool.

Same f-2698f5kpc closure; old protocol-14 / confirmedSizes observations in the proposal are superseded by current code. Installed 9953705a already includes current_size attach/replay; remaining proven gap is live Core dropping ctxmux resized events. Preserve Runtime ownership, no polling or second size cache, no resize echo loop.

The reviewed vertical task delivers the existing authoritative size event through Core/Attachment/Desktop and proves replay, live resize, and restart behavior. Focus-policy redesign and new user settings are out of scope; passive sync does not submit resize.

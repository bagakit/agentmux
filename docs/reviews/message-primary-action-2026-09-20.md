# Message Tools primary action and image sizing

User-confirmed change: one send/interrupt button, a filled square while working, proportional pasted thumbnails aligned with the text line.

Implemented on the existing AgentComposer action boundary: pointer interrupt preserves the Session; Enter/queue and Cmd/Ctrl+Enter steer remain distinct. Image display retains the original durable reference and enlarge interaction.

51 targeted tests pass. Three mutations are killed: route interrupt to send, restore the wrong glyph, and restore 48px image height. Product callers are AgentSessionComposer/NewTabSurface and InlineComposer's pasted-image node; this is not an unused helper. Installation and native visual verification are pending, so the feature task is not marked done.

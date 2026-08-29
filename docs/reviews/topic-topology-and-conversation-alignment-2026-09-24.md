# Topic topology navigation and conversation alignment review

Status: approved from the user's Topic screenshots and conversation reading feedback on 2026-09-24.

Decision: the Topic rail is a compact, navigable Tab strip. Each Tab glyph is an actual activation affordance that resolves to the existing Workspace/Tab/Region; hover and focus preview the same Tab without creating a second surface. The preview is one clean miniature of the real Region bounds, with identity icons inside Regions and no repeated Region list below it.

Human messages keep their right-docked conversation bubble, but the body content remains left aligned so Markdown, lists, tables, and code read from a stable left edge.

Acceptance proof: focused tests cover tab activation callbacks, compact rail and Region-map markup/style contracts, absence of the redundant activity list, and the human body text alignment rule. Mutating each contract makes its focused test red; production callers remain connected.

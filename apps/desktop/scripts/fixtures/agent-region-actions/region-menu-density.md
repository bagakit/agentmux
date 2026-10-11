# Compact Region menu review

Use this fixture's original `WorkspaceWorkbench`, `SessionPane`, Store and product
styles. Load the normal ThemeRuntime for semantic icons and theme tokens; do not
replace the menu or layout callbacks with a visual replica.

The presentation contract belongs to [Region menu icon rows](../../../../../docs/design/presentation/spaces-and-layout.md#region-菜单的分组图标行).
The review procedure belongs to [independent image review](../../../../../docs/guides/agent-visual-e2e-review.md).

Start with two original Regions and the survivor's nonempty draft. Open the
clicked Region's context menu and Agent More menu, the pane Split chooser, Browser
More, and Tab layout/group submenus through their original controls. Verify:

- Normal-width split and layout choices each occupy one content-aligned icon row,
  with no permanent caption. The fixed label slot shows the hovered or focused
  action; keyboard focus takes priority. Group names stay accessible, and a long
  action has a complete on-demand explanation, with no false selected state.
- Split, arrange and swap use the chosen original target. Surviving identities
  and draft remain intact. Tab-group movement keeps its distinct meaning.
- Hover keeps the editor caret, including crossing the swap submenu Portal and
  moving between targets. Leaving for another parent item closes that submenu.
- Keyboard navigation, typeahead, Enter, Space and Escape retain menu behavior;
  row-edge Left returns from a submenu. Touch can choose an original command.
- Narrow and short windows keep all eligible actions reachable. Inspect complete
  normal, narrow and short frames in both themes, including submenu placement.

Record source/style bindings and original Store receipts with the private review
evidence. An independent reviewer must open the complete images and assess them.
The fixture uses web-preview API data. It proves Renderer consumers and input
interaction; it does not prove native Runtime, Provider or OS window behavior.

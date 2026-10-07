/** AgentMux outline drawings. 24-unit grid; inherit the theme pen and instance color.
 * Keep object silhouettes quiet and leave enough negative space at 12–14px. */
export const AUTHORED_ICON_GLYPHS = {
  "work-writing": [["path",{"d":"M4 6h8 M4 12h5"}],["path",{"d":"M9 20l1-4 9-9 3 3-9 9-4 1Z"}]],
  "content-stream": [["path",{"d":"M4 6h16 M4 12h11 M4 18h7"}],["path",{"d":"M15 15v6"}]],
  "browser-executing": [["path",{"d":"M11 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"}],["path",{"d":"M3 9h4l2-3h5l2 3h5"}],["path",{"d":"M14 16h8m-3-3 3 3-3 3"}]],
  "work-history": [["path",{"d":"M6 7.5v3 M6 13.5v3 M11 6h9 M11 12h7 M11 18h9"}],["circle",{"cx":"6","cy":"6","r":"1.5"}],["circle",{"cx":"6","cy":"12","r":"1.5"}],["circle",{"cx":"6","cy":"18","r":"1.5"}]],
  "status-dot": [["circle",{"cx":"12","cy":"12","r":"10","fill":"currentColor","stroke":"none"}]],
  "redaction-block": [["rect",{"x":"3","y":"6","width":"18","height":"12","rx":"2","fill":"currentColor","stroke":"none"}]],
  "resize-corner": [["path",{"d":"M0 0H24V24H18V6H0Z","fill":"currentColor","stroke":"none"}]],
  "workflow-progress": [["circle",{"cx":"12","cy":"12","r":"8.25","opacity":".16"}],["circle",{"cx":"12","cy":"12","r":"8.25","pathLength":"100","stroke-dasharray":"30 70"}]],
  "mote-mark": [["path", {"d": "M7.1 3.8c1.6-1.6 4.5-2 6.5-.9l5 2.8c1.6.9 2.5 2.7 2.1 4.6l-.9 5.2c-.3 1.6-1.4 2.9-2.9 3.5l-4.5 2c-1.9.9-3.8.4-5.1-1.1l-3.6-4.2c-1.1-1.3-1.3-3.1-.7-4.7l2.2-5.1c.4-.8 1.1-1.5 1.9-2.1Zm8.2 2.9c-4.4 1.4-6.7 4.8-5.2 7.9.7 1.4 2 2.3 3.7 2.7-1.5-1.9-2.2-3.4-1.6-5.2.5-1.9 2-3.7 3.1-5.4Z", "fill": "currentColor", "fill-rule": "evenodd"}]],
  "process-live": [["rect", {"x":"3","y":"4","width":"18","height":"16","rx":"3"}], ["path", {"d":"M9 8l7 4-7 4Z"}]],
  "process-idle": [["rect", {"x":"3","y":"4","width":"18","height":"16","rx":"3"}], ["path", {"d":"M8 12h8"}]],
  "operation-wait": [["path", {"d":"M6 3h12 M6 21h12 M7 3v4c0 2 3 3 5 5-2 2-5 3-5 5v4 M17 3v4c0 2-3 3-5 5 2 2 5 3 5 5v4"}]],
  "input-needed": [["path", {"d":"M19 4H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2v3l5-3h7a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z M7 9h5 M16 8v6"}]],
} as const
export const AUTHORED_ICON_GLYPH_IDS = Object.keys(AUTHORED_ICON_GLYPHS) as Array<keyof typeof AUTHORED_ICON_GLYPHS>

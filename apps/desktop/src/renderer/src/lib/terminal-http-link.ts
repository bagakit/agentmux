/**
 * Bare HTTP(S) links printed as terminal text.
 *
 * xterm's WebLinksAddon deliberately stops only at ASCII whitespace/punctuation. Agent output is
 * often prose without a space after a URL, though, so a Chinese sentence such as
 * `https://example.test/docs中文。` would otherwise make the Han text part of the clickable span.
 * Keep the addon's strict URL grammar and add the CJK blocks to both the middle and final boundary.
 * Percent-encoded non-ASCII bytes remain valid because they are ASCII URL characters.
 *
 * This is intentionally only for the bare-text provider. OSC 8 has an explicit range supplied by
 * the terminal and must not be re-scanned or trimmed by this heuristic.
 */
export const TERMINAL_HTTP_URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]*[^\s"':,.!?{}|\\\^~\[\]`()<>\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

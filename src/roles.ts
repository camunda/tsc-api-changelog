/**
 * Request/response role classification based on naming heuristics.
 *
 * - Request types: old input must be accepted by new API → Stable→Current
 * - Response types: new output must satisfy old consumer → Current→Stable
 * - Unknown: check both directions
 */

export type TypeRole = 'request' | 'response' | 'unknown';

const REQUEST_PATTERNS = [
  /Data$/,
  /Request$/,
  /Filter$/,
  /Query$/,
  /Instruction$/,
  /Input$/,
  /input$/,
];

const RESPONSE_PATTERNS = [
  /Response$/,
  /Responses$/,
  /Result$/,
  /Error$/,
  /Errors$/,
];

export function classifyRole(name: string): TypeRole {
  if (REQUEST_PATTERNS.some((p) => p.test(name))) return 'request';
  if (RESPONSE_PATTERNS.some((p) => p.test(name))) return 'response';
  return 'unknown';
}

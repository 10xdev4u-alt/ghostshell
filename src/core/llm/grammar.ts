/**
 * Grammar-constrained decoding for tool calls.
 *
 * Small local models are unreliable at emitting valid JSON/XML. Constrained
 * decoding forces the model to produce a syntactically valid tool-call object,
 * converting a probabilistic parse into a guaranteed one.
 *
 * Strategy:
 *   1. Build a GBNF/JSON grammar from the tool schemas.
 *   2. Pass it to the engine (`req.grammar`).
 *   3. Parse with the grammar strategy first; fall back to Hermes/fenced.
 *
 * See docs/CREATIVE_INNOVATION.md §6.1.
 */

export function buildToolCallGrammar(tools: { name: string; parameters: unknown }[]): string {
  // TODO: emit a GBNF grammar that matches:
  //   {"tool_calls": [{"name": <one of tool names>, "arguments": <object>}]}
  void tools;
  throw new Error('buildToolCallGrammar not implemented (issue #18)');
}

export function buildToolCallSchema(tools: { name: string; parameters: unknown }[]): unknown {
  // TODO: emit a JSON Schema for the tool-call object.
  void tools;
  throw new Error('buildToolCallSchema not implemented (issue #18)');
}

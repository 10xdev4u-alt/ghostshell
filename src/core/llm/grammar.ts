/**
 * Grammar-constrained decoding for tool calls.
 *
 * Small local models are unreliable at emitting valid JSON/XML. Constrained
 * decoding forces the model to produce a syntactically valid tool-call object,
 * converting a probabilistic parse into a guaranteed one.
 *
 * Strategy (see docs/CREATIVE_INNOVATION.md §6.1):
 *   1. Build a GBNF grammar from the tool schemas (`buildToolCallGrammar`).
 *   2. Pass it to the engine (`GenerateRequest.grammar`).
 *   3. Parse with the grammar strategy first; fall back to Hermes/fenced.
 *
 * Two artifacts are produced:
 *   - `buildToolCallGrammar`  → a GBNF string (llama.cpp / GGUF tooling).
 *   - `buildToolCallSchema`   → a JSON Schema object (WebLLM JSON mode /
 *                               XGrammar, which accept schemas rather than GBNF).
 *
 * Both emit the tool-call shape:
 *
 *   {"tool_calls": [{"name": "<tool>", "arguments": {…}}]}
 *
 * The GBNF root also admits a final answer (`<answer>…</answer>`), so a
 * constrained model can finish a task without a tool call. The JSON Schema
 * emits the tool-call shape only.
 *
 * That shape is exactly what `parseToolCalls` (src/core/agent/parser.ts)
 * accepts as its first strategy, so a grammar-constrained response needs no
 * special handling downstream.
 *
 * The grammar builder is pure: it never touches a model, tokenizer, or the
 * network, which makes it trivially unit-testable.
 */

import type { JSONSchemaProperty } from '@/types/index.js';

/** Minimal tool description accepted by the grammar builders. */
export interface GrammarTool {
  name: string;
  parameters: unknown;
}

/** A tool definition for chat templates that support function calling. */
export interface ChatTool extends GrammarTool {
  /** Human-readable summary rendered into the prompt. */
  description?: string;
}

interface ToolSchema {
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

/**
 * Shared GBNF rules for JSON. Kept in `String.raw` so the escape sequences
 * (`\x7F`, `\n`, `\t`, `\"`, `\\`) survive verbatim into the emitted grammar.
 *
 * The `number` rule is copied verbatim from llama.cpp's `json.gbnf`,
 * including its exponent quirk: `[eE] [-+]? [0-9] [1-9]{0,15}` rejects
 * exponents with a `0` after the first digit (e.g. `1e10`). That is
 * intentional. Do not "fix" it here without changing llama.cpp too, or
 * grammar-constrained output will diverge from the reference runtime.
 */
const COMMON_RULES = String.raw`
char ::= [^"\\\x7F\x00-\x1F] | [\\] (["\\bfnrt] | "u" [0-9a-fA-F]{4})
string ::= "\"" char* "\"" space
number ::= ("-"? ([0-9] | [1-9] [0-9]{0,15})) ("." [0-9]+)? ([eE] [-+]? [0-9] [1-9]{0,15})? space
boolean ::= ("true" | "false") space
null ::= "null" space
array ::= "[" space (value ("," space value)*)? "]" space
object ::= "{" space (string ":" space value ("," space string ":" space value)*)? "}" space
value ::= object | array | string | number | boolean | null
additional-kv ::= string ":" space value
space ::= | " " | "\n" [ \t]{0,20}
`;

/**
 * Build a GBNF grammar for tool calls.
 *
 * The generated grammar:
 *   - enumerates every tool name, so the model cannot invent one;
 *   - emits `arguments` as a JSON object;
 *   - types each known property (string / number / boolean / array / object)
 *     and inlines `enum` values as literals;
 *   - requires the schema's `required` properties (in order) while still
 *     allowing optional and additional properties after them.
 *
 * GBNF was chosen because the model registry stores GGUF repos, llama.cpp is
 * the reference GBNF runtime, and the format is a plain string that fits
 * `GenerateRequest.grammar` without engine-specific adapters.
 */
export function buildToolCallGrammar(tools: GrammarTool[]): string {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('buildToolCallGrammar: at least one tool is required');
  }

  const lines: string[] = [];
  const callAlternatives: string[] = [];
  const toolSlugs = new SlugAllocator();

  for (const tool of tools) {
    const toolRule = toolSlugs.slug(tool.name);
    const schema = parseSchema(tool.parameters);
    const properties = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    const propertySlugs = new SlugAllocator();

    // One key/value rule per known property.
    for (const property of properties) {
      const definition = schema.properties?.[property];
      if (!definition) continue;
      lines.push(
        `args-${toolRule}-${propertySlugs.slug(property)}-kv ::= ${gbnfLiteral(property)} space ":" space ${valueRule(definition)}`,
      );
    }

    // A key/value alternative for every known property plus a generic escape
    // hatch, so the model can still emit properties added after this grammar
    // was generated.
    const kvAlternatives = [
      ...properties.map((property) => `args-${toolRule}-${propertySlugs.slug(property)}-kv`),
      'additional-kv',
    ];
    lines.push(`args-${toolRule}-kv ::= ${kvAlternatives.join(' | ')}`);

    // Required properties come first and are mandatory; everything after them
    // is optional. This mirrors llama.cpp's JSON-schema converter.
    const requiredSequence = properties
      .filter((property) => required.has(property))
      .map((property) => `args-${toolRule}-${propertySlugs.slug(property)}-kv`)
      .join(' "," space ');
    const objectBody = requiredSequence
      ? `${requiredSequence} ("," space (args-${toolRule}-kv ("," space args-${toolRule}-kv)*))?`
      : `(args-${toolRule}-kv ("," space args-${toolRule}-kv)*)?`;
    lines.push(`args-${toolRule} ::= "{" space ${objectBody} "}" space`);

    lines.push(
      `call-${toolRule} ::= "{" space "name" space ":" space ${gbnfLiteral(tool.name)} space "," space "arguments" space ":" space args-${toolRule} space "}" space`,
    );
    callAlternatives.push(`call-${toolRule}`);
  }

  lines.push(`call ::= ${callAlternatives.join(' | ')}`);
  lines.push(
    'tool-calls ::= "{" space "tool_calls" space ":" space "[" space call ("," space call)* "]" space "}" space',
  );
  // A final answer is plain text between <answer> tags. `answer-char` excludes
  // `<` so the closing tag is never consumed as content, and excludes `</` so
  // the first closing tag ends the answer.
  lines.push('answer-char ::= [^<] | "<" [^/]');
  lines.push('answer ::= "<answer>" answer-char* "</answer>" space');
  lines.push('root ::= tool-calls | answer');
  lines.push(COMMON_RULES.trim());

  return lines.join('\n');
}

/** One tool variant inside the `tool_calls` array. */
export interface ToolCallSchemaVariant {
  type: 'object';
  properties: {
    name: { type: 'string'; enum: string[] };
    arguments: unknown;
  };
  required: string[];
  additionalProperties: false;
}

/** JSON Schema for the tool-call envelope `buildToolCallSchema` emits. */
export interface ToolCallSchema {
  type: 'object';
  properties: {
    tool_calls: {
      type: 'array';
      items: { oneOf: ToolCallSchemaVariant[] };
    };
  };
  required: string[];
  additionalProperties: false;
}

/**
 * Build a JSON Schema for the same tool-call shape.
 *
 * Engines that support JSON-mode structured generation (WebLLM, XGrammar)
 * take a schema instead of a GBNF string. `oneOf` ties each tool name to its
 * own argument schema, which is the closest JSON Schema equivalent of the
 * GBNF dispatch in `buildToolCallGrammar`.
 *
 * This is a v1.0 API: it is exported and tested, but no caller in `src/`
 * uses it yet.
 */
export function buildToolCallSchema(tools: GrammarTool[]): ToolCallSchema {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error('buildToolCallSchema: at least one tool is required');
  }

  return {
    type: 'object',
    properties: {
      tool_calls: {
        type: 'array',
        items: {
          oneOf: tools.map((tool) => ({
            type: 'object',
            properties: {
              name: { type: 'string', enum: [tool.name] },
              arguments: tool.parameters,
            },
            required: ['name', 'arguments'],
            additionalProperties: false,
          })),
        },
      },
    },
    required: ['tool_calls'],
    additionalProperties: false,
  };
}

/**
 * Build the OpenAI-style function definitions a chat template's `tools`
 * argument expects.
 *
 * `apply_chat_template` forwards `tools` to the Jinja template, and Qwen's
 * template serializes each entry with `tojson`. The description belongs on the
 * inner `function` object, which is the format vLLM and the HF chat templating
 * guide use.
 */
export function buildToolDefinitions(tools: ChatTool[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.parameters,
    },
  }));
}

function parseSchema(parameters: unknown): ToolSchema {
  if (!parameters || typeof parameters !== 'object') return {};
  const candidate = parameters as ToolSchema;
  if (!candidate.properties || typeof candidate.properties !== 'object') return {};
  return candidate;
}

function valueRule(definition: JSONSchemaProperty): string {
  if (definition.enum && definition.enum.length > 0) {
    return `(${definition.enum.map((value) => gbnfLiteral(value)).join(' | ')})`;
  }
  switch (definition.type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'value';
  }
}

/** GBNF rule names are dashed lowercase words. */
function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'tool';
}

/** Short FNV-1a hash used to disambiguate colliding rule slugs. */
function slugHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Allocate GBNF rule-name fragments.
 *
 * Raw values are memoized, so a property referenced from several rules keeps
 * one name. Two different values can slug alike (`read-file`, `read_file`);
 * the second gets a hash suffix instead of emitting a duplicate rule, which
 * llama.cpp rejects as a parse error.
 */
class SlugAllocator {
  private readonly used = new Set<string>();
  private readonly memo = new Map<string, string>();

  slug(value: string): string {
    const memoized = this.memo.get(value);
    if (memoized !== undefined) return memoized;

    const base = slugify(value);
    const slug = this.used.has(base) ? this.unique(base, value) : base;
    this.used.add(slug);
    this.memo.set(value, slug);
    return slug;
  }

  private unique(base: string, value: string): string {
    const hash = slugHash(value);
    let slug = `${base}-${hash}`;
    let suffix = 1;
    while (this.used.has(slug)) {
      slug = `${base}-${hash}-${suffix}`;
      suffix += 1;
    }
    return slug;
  }
}

/**
 * Quote a string as a GBNF terminal.
 *
 * The `char` rule in `COMMON_RULES` excludes `"` and `\` (which must be
 * escaped) plus `\x00-\x1F` and `\x7F`. The named escapes cover the common
 * whitespace controls; every other control character uses `\uXXXX`.
 */
function gbnfLiteral(value: string): string {
  let escaped = '';
  for (const char of value) {
    switch (char) {
      case '\\':
        escaped += '\\\\';
        break;
      case '"':
        escaped += '\\"';
        break;
      case '\b':
        escaped += '\\b';
        break;
      case '\f':
        escaped += '\\f';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      default: {
        const code = char.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          escaped += `\\u${code.toString(16).padStart(4, '0')}`;
        } else {
          escaped += char;
        }
      }
    }
  }
  return `"${escaped}"`;
}

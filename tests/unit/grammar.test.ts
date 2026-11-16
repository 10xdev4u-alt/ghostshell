import { describe, expect, it } from 'vitest';
import { buildToolCallGrammar, buildToolCallSchema } from '@/core/llm/grammar.js';
import { builtinTools } from '@/core/agent/tools.js';

const tools = builtinTools().map((tool) => ({ name: tool.name, parameters: tool.parameters }));

function ruleNames(grammar: string): string[] {
  const names: string[] = [];
  for (const line of grammar.split('\n')) {
    const match = /^([a-zA-Z][a-zA-Z0-9-]*)\s*::=/.exec(line.trim());
    if (match) names.push(match[1]!);
  }
  return names;
}

function definedRules(grammar: string): Set<string> {
  return new Set(ruleNames(grammar));
}

function referencedRules(grammar: string): string[] {
  const refs: string[] = [];
  for (const line of grammar.split('\n')) {
    const body = line.replace(/^[a-zA-Z][a-zA-Z0-9-]*\s*::=/, '');
    const stripped = body
      .replace(/"(?:[^"\\]|\\.)*"/g, ' ') // string literals
      .replace(/\[[^\]]*\]/g, ' '); // character classes
    for (const match of stripped.matchAll(/[a-zA-Z][a-zA-Z0-9-]*/g)) {
      refs.push(match[0]);
    }
  }
  return refs;
}

function ruleBody(grammar: string, rule: string): string | undefined {
  const prefix = `${rule} ::=`
  const line = grammar.split('\n').find((candidate) => candidate.trim().startsWith(prefix));
  return line?.trim().slice(prefix.length).trim();
}

/**
 * The GBNF terminal whose matched text is the JSON encoding of `value`.
 *
 * Two layers are required, in order: `JSON.stringify` produces the JSON text
 * (surrounding quotes plus JSON escapes), then that text is escaped for GBNF
 * so its backslash escapes survive into the matched output rather than being
 * consumed by the grammar parser.
 */
function jsonQuotedTerminal(value: string): string {
  let out = '"';
  for (const char of JSON.stringify(value)) {
    if (char === '\\' || char === '"') out += '\\';
    out += char;
  }
  return `${out}"`;
}

describe('buildToolCallGrammar', () => {
  it('emits a GBNF grammar with a root rule', () => {
    const grammar = buildToolCallGrammar(tools);
    expect(grammar).toContain('root ::=');
    expect(grammar).toContain('tool_calls');
    expect(grammar).toContain('call ::=');
  });

  it('includes every tool name and property key as a JSON-quoted terminal', () => {
    const grammar = buildToolCallGrammar(tools);
    for (const tool of tools) {
      expect(grammar).toContain(jsonQuotedTerminal(tool.name));
    }
    expect(grammar).toContain(jsonQuotedTerminal('command'));
    expect(grammar).toContain(jsonQuotedTerminal('timeout_ms'));
    expect(grammar).toContain(jsonQuotedTerminal('path'));
    expect(grammar).toContain(jsonQuotedTerminal('pattern'));
  });

  it('inlines enum values as JSON-quoted literals', () => {
    const grammar = buildToolCallGrammar([
      {
        name: 'pick',
        parameters: {
          type: 'object',
          properties: { color: { type: 'string', enum: ['red', 'blue'] } },
          required: ['color'],
        },
      },
    ]);
    expect(grammar).toContain(jsonQuotedTerminal('red'));
    expect(grammar).toContain(jsonQuotedTerminal('blue'));
    expect(grammar).toContain('args-pick-color-kv');
  });

  it('emits JSON-quoted keys, tool names, and envelope tokens', () => {
    const grammar = buildToolCallGrammar([
      {
        name: 'bash',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ]);

    // GBNF string delimiters are syntax, not content: a bare `"name"` terminal
    // matches the characters name, which is invalid JSON. The emitted text has
    // to be `{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}`.
    expect(ruleBody(grammar, 'tool-calls')).toBe(
      '"{" space "\\"tool_calls\\"" space ":" space "[" space call ("," space call)* "]" space "}" space',
    );
    expect(ruleBody(grammar, 'call-bash')).toBe(
      '"{" space "\\"name\\"" space ":" space "\\"bash\\"" space "," space "\\"arguments\\"" space ":" space args-bash space "}" space',
    );
    expect(ruleBody(grammar, 'args-bash-command-kv')).toBe(
      '"\\"command\\"" space ":" space string',
    );
  });

  it('emits no unquoted JSON token in the tool-call rules', () => {
    const grammar = buildToolCallGrammar(tools);
    const jsonRules = grammar
      .split('\n')
      .filter((line) => /^(tool-calls|call-|args-)[a-z0-9-]* ::=/.test(line.trim()));
    const punctuation = new Set(['"{"', '"}"', '"["', '"]"', '":"', '","']);
    const literals = jsonRules.join('\n').match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      if (punctuation.has(literal)) continue;
      expect(
        literal.startsWith('"\\"') && literal.endsWith('\\""'),
        `unquoted JSON token: ${literal}`,
      ).toBe(true);
    }
  });

  it('serializes values to JSON before escaping the GBNF terminal', () => {
    // `JSON.stringify('a"b')` is `"a\"b"`. The terminal has to carry that
    // backslash through GBNF's own escapes, so the matched text stays valid
    // JSON instead of collapsing to `"a"b"`.
    const quoted = buildToolCallGrammar([
      { name: 'a"b', parameters: { type: 'object', properties: {} } },
    ]);
    expect(quoted).toContain('"\\"a\\\\\\"b\\""');

    // A newline is serialized as the two characters `\` + `n`; doubling the
    // backslash keeps it as JSON escape text instead of a raw newline inside
    // the matched string.
    const newline = buildToolCallGrammar([
      { name: 'line\nbreak', parameters: { type: 'object', properties: {} } },
    ]);
    expect(newline).toContain('"\\"line\\\\nbreak\\""');
  });

  it('escapes control characters in GBNF literals', () => {
    const grammar = buildToolCallGrammar([
      {
        name: 'line\nbreak',
        parameters: {
          type: 'object',
          properties: {
            'tab\tkey': {
              type: 'string',
              enum: [
                'carriage\rreturn',
                'back\bspace',
                'form\ffeed',
                'bell\u0007',
                'nul\u0000',
                'unit\u001fsep',
              ],
            },
          },
        },
      },
    ]);

    expect(grammar).toContain(jsonQuotedTerminal('line\nbreak'));
    expect(grammar).toContain(jsonQuotedTerminal('tab\tkey'));
    expect(grammar).toContain(jsonQuotedTerminal('carriage\rreturn'));
    expect(grammar).toContain(jsonQuotedTerminal('back\bspace'));
    expect(grammar).toContain(jsonQuotedTerminal('form\ffeed'));
    expect(grammar).toContain(jsonQuotedTerminal('bell\u0007'));
    expect(grammar).toContain(jsonQuotedTerminal('nul\u0000'));
    expect(grammar).toContain(jsonQuotedTerminal('unit\u001fsep'));

    // No raw control characters survive inside an emitted string literal.
    const literals = grammar.match(/"(?:[^"\\\n]|\\.)*"/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      expect(literal).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(grammar).not.toMatch(/[\r\t]/);
  });

  it('requires the schema required properties', () => {
    const grammar = buildToolCallGrammar([
      {
        name: 'write_file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
        },
      },
    ]);
    expect(grammar).toContain(
      'args-write-file ::= "{" space args-write-file-path-kv "," space args-write-file-content-kv',
    );
  });

  it('only references rules it defines', () => {
    const grammar = buildToolCallGrammar(tools);
    const defined = definedRules(grammar);
    expect(defined.size).toBeGreaterThan(0);
    for (const ref of referencedRules(grammar)) {
      expect(defined.has(ref), `undefined rule: ${ref}`).toBe(true);
    }
  });

  it('admits both a tool call and a final answer from the root rule', () => {
    const grammar = buildToolCallGrammar(tools);

    expect(ruleBody(grammar, 'root')).toBe('tool-calls | answer');
    expect(ruleBody(grammar, 'tool-calls')).toContain(jsonQuotedTerminal('tool_calls'));
    expect(ruleBody(grammar, 'answer')).toBe('"<answer>" answer-char* "</answer>" space');
    expect(ruleBody(grammar, 'answer-char')).toBe('[^<] | "<" [^/]');

    // The final-answer branch must not reference an undefined rule.
    const defined = definedRules(grammar);
    for (const ref of referencedRules(grammar)) {
      expect(defined.has(ref), `undefined rule: ${ref}`).toBe(true);
    }
  });

  it('disambiguates tool names that slug to the same rule name', () => {
    const grammar = buildToolCallGrammar([
      { name: 'read-file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);

    const names = ruleNames(grammar);
    expect(new Set(names).size).toBe(names.length);
    const defined = definedRules(grammar);
    for (const ref of referencedRules(grammar)) {
      expect(defined.has(ref), `undefined rule: ${ref}`).toBe(true);
    }
    expect(grammar).toContain(jsonQuotedTerminal('read-file'));
    expect(grammar).toContain(jsonQuotedTerminal('read_file'));
  });

  it('disambiguates property names that slug to the same rule name', () => {
    const grammar = buildToolCallGrammar([
      {
        name: 'write',
        parameters: {
          type: 'object',
          properties: {
            'file-path': { type: 'string' },
            file_path: { type: 'string' },
          },
        },
      },
    ]);

    const names = ruleNames(grammar);
    expect(new Set(names).size).toBe(names.length);
    const defined = definedRules(grammar);
    for (const ref of referencedRules(grammar)) {
      expect(defined.has(ref), `undefined rule: ${ref}`).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(buildToolCallGrammar(tools)).toBe(buildToolCallGrammar(tools));
  });

  it('handles a tool with no properties', () => {
    const grammar = buildToolCallGrammar([
      { name: 'ping', parameters: { type: 'object', properties: {} } },
    ]);
    expect(grammar).toContain('args-ping ::=');
    expect(grammar).toContain('call-ping');
  });

  it('throws on an empty tool list', () => {
    expect(() => buildToolCallGrammar([])).toThrow(/at least one tool/);
  });
});

describe('buildToolCallSchema', () => {
  it('builds a JSON schema with one variant per tool', () => {
    const schema = buildToolCallSchema(tools);

    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['tool_calls']);
    expect(schema.properties.tool_calls.type).toBe('array');

    const variants = schema.properties.tool_calls.items.oneOf;
    expect(variants).toHaveLength(tools.length);
    expect(variants.map((variant) => variant.properties.name.enum[0])).toEqual(
      tools.map((tool) => tool.name),
    );
    for (const variant of variants) {
      expect(variant.required).toEqual(['name', 'arguments']);
    }
  });

  it('throws on an empty tool list', () => {
    expect(() => buildToolCallSchema([])).toThrow(/at least one tool/);
  });
});

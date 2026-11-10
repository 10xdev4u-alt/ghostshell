import { describe, expect, it } from 'vitest';
import { buildToolCallGrammar, buildToolCallSchema } from '@/core/llm/grammar.js';
import { builtinTools } from '@/core/agent/tools.js';

const tools = builtinTools().map((tool) => ({ name: tool.name, parameters: tool.parameters }));

function definedRules(grammar: string): Set<string> {
  const rules = new Set<string>();
  for (const line of grammar.split('\n')) {
    const match = /^([a-zA-Z][a-zA-Z0-9-]*)\s*::=/.exec(line.trim());
    if (match) rules.add(match[1]!);
  }
  return rules;
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

describe('buildToolCallGrammar', () => {
  it('emits a GBNF grammar with a root rule', () => {
    const grammar = buildToolCallGrammar(tools);
    expect(grammar).toContain('root ::=');
    expect(grammar).toContain('tool_calls');
    expect(grammar).toContain('call ::=');
  });

  it('includes every tool name and property key', () => {
    const grammar = buildToolCallGrammar(tools);
    for (const tool of tools) {
      expect(grammar).toContain(`"${tool.name}"`);
    }
    expect(grammar).toContain('"command"');
    expect(grammar).toContain('"timeout_ms"');
    expect(grammar).toContain('"path"');
    expect(grammar).toContain('"pattern"');
  });

  it('inlines enum values as literals', () => {
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
    expect(grammar).toContain('"red"');
    expect(grammar).toContain('"blue"');
    expect(grammar).toContain('args-pick-color-kv');
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
    const schema = buildToolCallSchema(tools) as {
      type: string;
      properties: {
        tool_calls: {
          type: string;
          items: {
            oneOf: Array<{
              properties: {
                name: { enum: string[] };
                arguments: unknown;
              };
              required: string[];
            }>;
          };
        };
      };
      required: string[];
    };

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

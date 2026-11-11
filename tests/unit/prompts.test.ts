import { describe, expect, it } from 'vitest';
import {
  BASE_SYSTEM_PROMPT,
  buildSystemPrompt,
  CONTINUE_PROMPT,
  CORRECTIVE_RETRY_PROMPT,
} from '@/core/agent/prompts.js';

/**
 * The system prompt is assembled from the static base template plus the
 * runtime model/workspace/date. Tests pin the shape so a template edit cannot
 * silently drop the output-format contract the parser relies on.
 */

describe('buildSystemPrompt', () => {
  it('includes the base template, model, workspace, and date', () => {
    const prompt = buildSystemPrompt({ modelName: 'Qwen2.5-1.5B', workspace: '/root/workspace' });

    expect(prompt).toContain(BASE_SYSTEM_PROMPT);
    expect(prompt).toContain('Model: Qwen2.5-1.5B');
    expect(prompt).toContain('Workspace: /root/workspace');
    expect(prompt).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    expect(prompt).not.toContain('undefined');
  });

  it('appends the extra fragment when provided', () => {
    const prompt = buildSystemPrompt({
      modelName: 'M',
      workspace: '/w',
      extra: 'Extra instructions.',
    });
    expect(prompt).toContain('Extra instructions.');
    expect(prompt.endsWith('Extra instructions.')).toBe(true);
  });

  it('omits the extra fragment when it is empty', () => {
    const withoutExtra = buildSystemPrompt({ modelName: 'M', workspace: '/w' });
    const withEmptyExtra = buildSystemPrompt({ modelName: 'M', workspace: '/w', extra: '' });
    expect(withEmptyExtra).toBe(withoutExtra);
    expect(withEmptyExtra).not.toContain('undefined');
  });

  it('exports the retry prompts used by the loop', () => {
    expect(CORRECTIVE_RETRY_PROMPT).toContain('<tool_call>');
    expect(CONTINUE_PROMPT).toContain('<answer>');
  });
});

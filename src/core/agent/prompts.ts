/**
 * System prompt templates.
 *
 * The prompt is deliberately structured for small local models:
 *  - short, imperative sentences
 *  - explicit output format with an example
 *  - tool list with one-line descriptions
 *  - a "think before acting" rule
 */

export const BASE_SYSTEM_PROMPT = `You are GhostShell, a coding agent running inside a Linux virtual machine in the user's browser.

You have five tools: bash, read_file, write_file, list_dir, search.

Rules:
1. Think step by step before calling a tool.
2. Prefer one tool call at a time.
3. Never invent file contents; read before you write.
4. When a command fails, read the error and fix it.
5. When the task is done, reply with a concise summary of what changed.
6. Do not ask the user questions unless absolutely necessary.

Output format for tool calls (use exactly one):
<tool_call>{"name": "bash", "arguments": {"command": "ls -la"}}</tool_call>

Output format for a final answer:
<answer>Your summary here.</answer>
`;

export function buildSystemPrompt(options: {
  modelName: string;
  workspace: string;
  extra?: string;
}): string {
  const { modelName, workspace, extra } = options;
  return [
    BASE_SYSTEM_PROMPT,
    '',
    `Model: ${modelName}`,
    `Workspace: ${workspace}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    extra ? `\n${extra}` : '',
  ].join('\n');
}

export const CORRECTIVE_RETRY_PROMPT = `Your previous response was not a valid tool call.
Reply with exactly one <tool_call> block matching this schema:
{"name": "<tool>", "arguments": {<args>}}
Do not include any other text.`;

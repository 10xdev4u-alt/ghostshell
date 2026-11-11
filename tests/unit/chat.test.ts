import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types/index.js';
import { createChat, renderMarkdown } from '@/ui/chat.js';
import {
  FakeElement,
  FakeEvent,
  findAllByClass,
  findByClass,
  installFakeDocument,
} from './helpers/dom.js';

/**
 * Chat panel tests.
 *
 * The panel renders model-controlled strings with textContent only, wires the
 * composer, adds twin-view jump links, and derives ok/error styling from the
 * built-in tools' output markers. The DOM stub covers the surface the panel
 * uses; the assertions check the rendered structure and the user-visible
 * behavior.
 */

function makeMessage(role: Message['role'], content: string, extra?: Partial<Message>): Message {
  return { id: `m-${role}-${Math.random()}`, role, content, timestamp: 1, ...extra };
}

function mount(): { container: FakeElement; chat: ReturnType<typeof createChat> } {
  installFakeDocument();
  const container = new FakeElement('div');
  const chat = createChat(container as unknown as HTMLElement);
  return { container, chat };
}

function streamOf(container: FakeElement): FakeElement {
  const stream = container.children[0];
  if (!stream) throw new Error('chat did not mount a stream');
  return stream;
}

function cardOf(container: FakeElement, index = 0): FakeElement {
  return streamOf(container).children[index]!;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat panel', () => {
  it('renders tool messages with ok/error styling', () => {
    const { container, chat } = mount();
    chat.render([
      makeMessage('tool', 'hello\n[exit 0] [1ms]'),
      makeMessage('tool', 'command not found\n[exit 127] [2ms]'),
    ]);

    const ok = findByClass(cardOf(container, 0), 'gs-tool-result');
    expect(ok?.className).toContain('is-ok');
    expect(ok?.textContent).toContain('hello');

    const error = findByClass(cardOf(container, 1), 'gs-tool-result');
    expect(error?.className).toContain('is-error');
    expect(error?.textContent).toContain('command not found');
  });

  it('prefers a structured toolResults state over the content', () => {
    const { container, chat } = mount();
    chat.render([
      makeMessage('tool', 'looks fine\n[exit 0]', {
        toolResults: [{ ok: false, content: 'looks fine\n[exit 0]' }],
      }),
    ]);

    const result = findByClass(cardOf(container), 'gs-tool-result');
    expect(result?.className).toContain('is-error');
  });

  it('still renders legacy assistant toolResults', () => {
    const { container, chat } = mount();
    chat.render([
      makeMessage('assistant', 'done', {
        toolResults: [{ ok: true, content: 'a.txt\nb.txt' }],
      }),
    ]);

    const result = findByClass(cardOf(container), 'gs-tool-result');
    expect(result?.className).toContain('is-ok');
    expect(result?.textContent).toContain('a.txt');
  });

  it('renders a role header and body text for plain messages', () => {
    const { container, chat } = mount();
    chat.render([makeMessage('user', 'hello there')]);

    const card = cardOf(container);
    expect(card.className).toContain('gs-msg--user');
    expect(findByClass(card, 'gs-msg-role')?.textContent).toBe('user');
    expect(findByClass(card, 'gs-msg-body')?.textContent).toBe('hello there');
  });

  it('renders a placeholder for an empty message', () => {
    const { container, chat } = mount();
    chat.render([makeMessage('assistant', '')]);
    expect(findByClass(cardOf(container), 'gs-msg-body')?.textContent).toBe('(no content)');
  });

  it('renders assistant tool calls as collapsible details', () => {
    const { container, chat } = mount();
    chat.render([
      makeMessage('assistant', '', {
        toolCalls: [{ id: 't1', name: 'bash', arguments: { command: 'ls -la' }, raw: '' }],
      }),
    ]);

    const call = findByClass(cardOf(container), 'gs-tool-call');
    expect(call?.tagName).toBe('details');
    expect(call?.children[0]?.textContent).toBe('🔧 bash');
    expect(call?.children[1]?.textContent).toBe(JSON.stringify({ command: 'ls -la' }, null, 2));
  });

  it('replaces the stream on render', () => {
    const { container, chat } = mount();
    const first = makeMessage('user', 'one');
    const second = makeMessage('user', 'two');
    chat.render([first]);
    chat.render([second]);
    expect(streamOf(container).children).toHaveLength(1);
    expect(findByClass(cardOf(container), 'gs-msg-body')?.textContent).toBe('two');
  });

  it('appends a message and scrolls to the bottom', () => {
    const { container, chat } = mount();
    const stream = streamOf(container);
    stream.scrollHeight = 42;
    chat.append(makeMessage('user', 'hi'));
    expect(stream.children).toHaveLength(1);
    expect(stream.scrollTop).toBe(42);
  });

  it('annotates tool calls with jump links and reports the range on click', () => {
    const { container, chat } = mount();
    const message = makeMessage('assistant', '', {
      toolCalls: [
        { id: 't1', name: 'bash', arguments: {}, raw: '' },
        { id: 't2', name: 'read_file', arguments: {}, raw: '' },
      ],
    });
    chat.render([message]);
    const onJump = vi.fn();

    chat.annotateToolCalls(
      message.id,
      [
        { start: 1, end: 2, callId: 't1' },
        { start: 5, end: 4, callId: 't2' },
        { start: 9, end: 9, callId: 'missing' },
      ],
      onJump,
    );

    const buttons = findAllByClass(streamOf(container).children[0]!, 'gs-tool-range');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.textContent).toBe('Lines 1–2');
    expect(buttons[1]!.textContent).toBe('Line 5');

    buttons[0]!.click();
    expect(onJump).toHaveBeenCalledWith(1, 2);
  });

  it('ignores annotations for an unknown message', () => {
    const { container, chat } = mount();
    chat.render([makeMessage('user', 'hi')]);
    expect(() => chat.annotateToolCalls('nope', [], vi.fn())).not.toThrow();
    expect(streamOf(container).children[0]!.children.some((c) => c.className.includes('gs-tool-range'))).toBe(false);
  });

  it('disables the composer and shows a status while working', () => {
    const { container, chat } = mount();
    const send = findByClass(container, 'gs-chat-send')!;
    const input = findByClass(container, 'gs-chat-input')!;
    const status = findByClass(container, 'gs-chat-status')!;

    chat.setWorking(true);
    expect(send.disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(status.textContent).toBe('Working…');

    chat.setWorking(false);
    expect(send.disabled).toBe(false);
    expect(input.disabled).toBe(false);
    expect(status.textContent).toBe('');
  });

  it('submits on click, ignoring empty input', () => {
    const { container, chat } = mount();
    const send = findByClass(container, 'gs-chat-send')!;
    const input = findByClass(container, 'gs-chat-input')!;
    const onSubmit = vi.fn();
    chat.onSubmit(onSubmit);
    chat.attach();

    input.value = '  hello  ';
    send.click();
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');

    input.value = '   ';
    send.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('submits on Enter without Shift and prevents the newline', () => {
    const { container, chat } = mount();
    const input = findByClass(container, 'gs-chat-input')!;
    const onSubmit = vi.fn();
    chat.onSubmit(onSubmit);
    chat.attach();

    input.value = 'hi';
    const event = new FakeEvent('keydown', { key: 'Enter' });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });

  it('does not submit on Shift+Enter', () => {
    const { container, chat } = mount();
    const input = findByClass(container, 'gs-chat-input')!;
    const onSubmit = vi.fn();
    chat.onSubmit(onSubmit);
    chat.attach();

    input.value = 'hi';
    const event = new FakeEvent('keydown', { key: 'Enter', shiftKey: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('attaches listeners only once', () => {
    const { container, chat } = mount();
    const send = findByClass(container, 'gs-chat-send')!;
    const input = findByClass(container, 'gs-chat-input')!;
    const onSubmit = vi.fn();
    chat.onSubmit(onSubmit);
    chat.attach();
    chat.attach();

    input.value = 'hi';
    send.click();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('removes listeners and elements on dispose', () => {
    const { container, chat } = mount();
    const send = findByClass(container, 'gs-chat-send')!;
    const input = findByClass(container, 'gs-chat-input')!;
    const onSubmit = vi.fn();
    chat.onSubmit(onSubmit);
    chat.attach();

    chat.dispose();
    expect(container.children).toHaveLength(0);

    input.value = 'hi';
    send.click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('derives error styling from tool output markers', () => {
    const { container, chat } = mount();
    const cases: Array<[string, boolean]> = [
      ['bash failed: no such file', false],
      ['Missing required argument: path', false],
      ['this appears to be a binary file', false],
      ['Unknown tool nope', false],
      ['Command timed out after 1000ms', false],
      ['grep exited with code 2', false],
      ['grep exited with code 1', true],
      ['grep exited with code 0', true],
      ['all good', true],
    ];

    for (const [content, ok] of cases) {
      chat.render([makeMessage('tool', content)]);
      const result = findByClass(cardOf(container), 'gs-tool-result');
      expect(result?.className.includes(ok ? 'is-ok' : 'is-error')).toBe(true);
    }
  });

  it('lets a structured tool result override the content markers', () => {
    const { container, chat } = mount();
    chat.render([
      makeMessage('tool', '[exit 1]', {
        toolResults: [{ ok: true, content: '[exit 1]' }],
      }),
    ]);
    expect(findByClass(cardOf(container), 'gs-tool-result')?.className).toContain('is-ok');
  });
});

describe('renderMarkdown', () => {
  it('escapes HTML before applying the markdown subset', () => {
    expect(renderMarkdown('**bold** and `code`')).toBe('<strong>bold</strong> and <code>code</code>');
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
  });
});

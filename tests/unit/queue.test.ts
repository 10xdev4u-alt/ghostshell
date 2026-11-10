import { describe, expect, it } from 'vitest';
import { SerialQueue } from '@/lib/queue.js';

describe('SerialQueue', () => {
  it('runs tasks in order', async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) =>
      queue.add(async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10));
        order.push(i);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('continues after a failure', async () => {
    const queue = new SerialQueue();
    const results: string[] = [];
    await queue.add(async () => {
      throw new Error('boom');
    }).catch(() => results.push('caught'));
    await queue.add(async () => {
      results.push('ok');
    });
    expect(results).toEqual(['caught', 'ok']);
  });

  it('tracks pending count', async () => {
    const queue = new SerialQueue();
    expect(queue.length).toBe(0);
    const task = queue.add(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(queue.length).toBe(1);
    await task;
    expect(queue.length).toBe(0);
  });
});

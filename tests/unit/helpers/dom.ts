import { vi } from 'vitest';

/**
 * Minimal DOM stub for UI unit tests. Supports the surface the panels use:
 * createElement, appendChild/append/replaceChildren, classList, dataset,
 * style, addEventListener/removeEventListener, and setAttribute.
 */

export class FakeClassList {
  private readonly classes = new Set<string>();

  add(...names: string[]): void {
    for (const name of names) this.classes.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.classes.delete(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const shouldAdd = force === undefined ? !this.classes.has(name) : force;
    if (shouldAdd) this.classes.add(name);
    else this.classes.delete(name);
    return shouldAdd;
  }

  contains(name: string): boolean {
    return this.classes.has(name);
  }

  toString(): string {
    return [...this.classes].join(' ');
  }
}

export class FakeStyle {
  display = '';
  paddingLeft = '';
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string | undefined {
    return this.properties.get(name);
  }
}

export class FakeEvent {
  type: string;
  key: string | undefined;
  shiftKey = false;
  defaultPrevented = false;

  constructor(type: string, init: { key?: string; shiftKey?: boolean } = {}) {
    this.type = type;
    this.key = init.key;
    this.shiftKey = init.shiftKey ?? false;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener = (event: FakeEvent) => void;

export class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  classList = new FakeClassList();
  dataset: Record<string, string> = {};
  style = new FakeStyle();
  scrollTop = 0;
  scrollHeight = 0;
  value = '';
  disabled = false;
  hidden = false;
  tabIndex = -1;
  type = '';
  placeholder = '';
  rows = 1;
  srcdoc = '';

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: FakeEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }

  click(): void {
    this.dispatchEvent(new FakeEvent('click'));
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }
}

export function installFakeDocument(): void {
  vi.stubGlobal('document', {
    createElement: (tagName: string) => new FakeElement(tagName),
  });
}

export function findByClass(root: FakeElement, className: string): FakeElement | undefined {
  if (root.className.split(/\s+/).includes(className)) return root;
  if (root.classList.contains(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

export function findAllByClass(root: FakeElement, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    if (el.className.split(/\s+/).includes(className) || el.classList.contains(className)) {
      out.push(el);
    }
    for (const child of el.children) walk(child);
  };
  walk(root);
  return out;
}

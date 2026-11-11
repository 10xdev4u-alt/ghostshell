import type { Database, Recipe, ToolContext, ToolDefinition } from '@/types/index.js';
import { sha256Hex, stableStringify } from '@/core/security/attestation.js';

/**
 * Recipe / skill packages.
 *
 * A recipe bundles a prompt fragment, tool allowlist, setup script, and evals.
 * Install = verify sha256 -> run setup.sh in the VM -> merge prompt -> register
 * tools. See docs/CREATIVE_INNOVATION.md §3.2.
 *
 * Integrity covers the canonical recipe JSON (keys sorted recursively,
 * `undefined` dropped, `integrity` excluded) rather than the raw file, so the
 * hash is stable across formatting and key order. Recompute it with
 * `computeIntegrity` after editing a manifest.
 *
 * Intended wiring (owned by src/app.ts, not modified here):
 *
 *   const recipes = createRecipeManager({ db });
 *   await recipes.load();
 *   // ...
 *   // in App.start():
 *   const registry = createToolRegistry(recipes.resolveTools(builtinTools()));
 *   this.loop = new AgentLoop(registry, {
 *     ...config,
 *     systemPrompt: recipes.applySystemPrompt(
 *       buildSystemPrompt({ modelName, workspace }),
 *     ),
 *   });
 *
 * `resolveTools` returns every definition unchanged while no recipes are
 * installed, so the base tool set is untouched until a recipe restricts it.
 */

/** IndexedDB settings key holding the installed recipe registry. */
export const RECIPES_SETTING_KEY = 'plugins.recipes.installed';

/** Setup/unsetup scripts run under the same cap as the bash tool. */
export const RECIPE_SCRIPT_TIMEOUT_MS = 120_000;

export interface RecipeManagerOptions {
  /** Settings store used to persist the installed registry. */
  db?: Database | undefined;
  /** Timeout for setup/unsetup scripts. Defaults to 120s. */
  scriptTimeoutMs?: number | undefined;
}

export interface RecipeManager {
  list(): Recipe[];
  get(name: string): Recipe | undefined;
  isInstalled(name: string): boolean;
  install(recipe: Recipe, ctx: ToolContext): Promise<void>;
  /** The VM context is optional; the context from `install` is reused. */
  uninstall(name: string, ctx?: ToolContext): Promise<void>;
  verify(recipe: Recipe): Promise<boolean>;
  /** Restore the registry from the settings store, skipping invalid entries. */
  load(): Promise<void>;
  /** Persist the registry to the settings store. */
  save(): Promise<void>;
  /** Concatenated prompt fragments from the installed recipes. */
  systemPrompt(): string;
  /** Merge the recipe fragments into a base system prompt. */
  applySystemPrompt(base: string): string;
  /** Union of the tool names allowlisted by installed recipes, sorted. */
  toolNames(): string[];
  /**
   * Restrict tool definitions to the installed recipes' allowlists. With no
   * recipes installed this returns every definition unchanged.
   */
  resolveTools(definitions: ToolDefinition[]): ToolDefinition[];
}

/**
 * Canonical JSON covered by `integrity.sha256`.
 *
 * `stableStringify` sorts keys recursively and drops `undefined` values;
 * `integrity` is overridden with `undefined` so a manifest never contains the
 * hash of itself.
 */
export function canonicalRecipe(recipe: Recipe): string {
  return stableStringify({ ...recipe, integrity: undefined });
}

/** Compute the integrity hash for a recipe manifest. */
export async function computeIntegrity(recipe: Recipe): Promise<string> {
  return sha256Hex(canonicalRecipe(recipe));
}

/** Constant-time hex comparison so a wrong hash does not leak by timing. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify a recipe against its `integrity.sha256`. Empty hashes never pass. */
export async function verifyRecipe(recipe: Recipe): Promise<boolean> {
  const expected = recipe.integrity?.sha256;
  if (!expected) return false;
  return timingSafeEqualHex(await computeIntegrity(recipe), expected);
}

/** Runtime check for persisted or imported manifests. */
export function isRecipe(value: unknown): value is Recipe {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    record['name'].length > 0 &&
    typeof record['version'] === 'string' &&
    typeof record['description'] === 'string' &&
    typeof record['license'] === 'string' &&
    typeof record['author'] === 'string' &&
    typeof record['prompt'] === 'string' &&
    Array.isArray(record['tools']) &&
    record['tools'].every((tool) => typeof tool === 'string') &&
    typeof record['setup'] === 'string' &&
    (record['unsetup'] === undefined || typeof record['unsetup'] === 'string') &&
    isIntegrity(record['integrity'])
  );
}

function isIntegrity(value: unknown): value is { sha256: string } {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>)['sha256'] === 'string';
}

function slug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'recipe';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cloneRecipe(recipe: Recipe): Recipe {
  return { ...recipe, tools: [...recipe.tools] };
}

async function runScript(
  ctx: ToolContext,
  recipe: Recipe,
  script: string,
  kind: 'setup' | 'unsetup',
  timeoutMs: number,
): Promise<void> {
  const dir = `/tmp/ghostshell/recipes/${slug(recipe.name)}`;
  const path = `${dir}/${kind}.sh`;
  await ctx.vm.exec(`mkdir -p ${shellQuote(dir)}`);
  await ctx.vm.write(path, `${script.replace(/\r\n/g, '\n').trimEnd()}\n`);
  const result = await ctx.vm.exec(`bash ${shellQuote(path)}`, timeoutMs);
  if (result.timedOut || result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
    const status = result.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${result.exitCode}`;
    throw new Error(
      `Recipe "${recipe.name}" ${kind} failed (${status})${detail ? `: ${detail}` : ''}`,
    );
  }
}

export function createRecipeManager(options: RecipeManagerOptions = {}): RecipeManager {
  const installed = new Map<string, Recipe>();
  let db = options.db ?? null;
  let lastCtx: ToolContext | null = null;
  const scriptTimeoutMs = options.scriptTimeoutMs ?? RECIPE_SCRIPT_TIMEOUT_MS;

  const persist = async (): Promise<void> => {
    if (!db) return;
    await db.setSetting(RECIPES_SETTING_KEY, [...installed.values()].map(cloneRecipe));
  };

  const systemPrompt = (): string =>
    [...installed.values()]
      .map((recipe) => recipe.prompt.trim())
      .filter((prompt) => prompt.length > 0)
      .join('\n\n');

  const applySystemPrompt = (base: string): string => {
    const fragment = systemPrompt();
    if (!fragment) return base;
    const trimmed = base.trim();
    return trimmed ? `${trimmed}\n\n${fragment}` : fragment;
  };

  const toolNames = (): string[] => {
    const names = new Set<string>();
    for (const recipe of installed.values()) {
      for (const tool of recipe.tools) names.add(tool);
    }
    return [...names].sort();
  };

  const resolveTools = (definitions: ToolDefinition[]): ToolDefinition[] => {
    const allowed = toolNames();
    if (allowed.length === 0) return [...definitions];
    const set = new Set(allowed);
    return definitions.filter((definition) => set.has(definition.name));
  };

  return {
    list: () => [...installed.values()].map(cloneRecipe),

    get: (name) => {
      const recipe = installed.get(name);
      return recipe ? cloneRecipe(recipe) : undefined;
    },

    isInstalled: (name) => installed.has(name),

    async install(recipe, ctx) {
      if (!isRecipe(recipe)) throw new Error('Invalid recipe manifest');
      if (!(await verifyRecipe(recipe))) {
        throw new Error(`Integrity check failed: ${recipe.name}`);
      }
      db = db ?? ctx.db ?? null;
      lastCtx = ctx;
      await runScript(ctx, recipe, recipe.setup, 'setup', scriptTimeoutMs);
      installed.set(recipe.name, cloneRecipe(recipe));
      await persist();
    },

    async uninstall(name, ctx) {
      const recipe = installed.get(name);
      if (!recipe) throw new Error(`Recipe not installed: ${name}`);
      if (recipe.unsetup !== undefined) {
        const vmCtx = ctx ?? lastCtx;
        if (!vmCtx) {
          throw new Error(`Cannot undo setup for "${name}": no VM context available`);
        }
        await runScript(vmCtx, recipe, recipe.unsetup, 'unsetup', scriptTimeoutMs);
      }
      installed.delete(name);
      await persist();
    },

    verify: (recipe) => verifyRecipe(recipe),

    async load() {
      if (!db) return;
      const raw = await db.getSetting<unknown>(RECIPES_SETTING_KEY);
      if (raw === undefined) return;
      if (!Array.isArray(raw)) {
        console.warn(
          `[ghostshell] ignoring malformed recipe registry at ${RECIPES_SETTING_KEY}`,
        );
        return;
      }
      const loaded: Recipe[] = [];
      for (const item of raw) {
        if (!isRecipe(item) || !(await verifyRecipe(item))) {
          console.warn('[ghostshell] skipping an invalid recipe in the persisted registry');
          continue;
        }
        loaded.push(item);
      }
      installed.clear();
      for (const recipe of loaded) installed.set(recipe.name, recipe);
    },

    save: () => persist(),

    systemPrompt,
    applySystemPrompt,
    toolNames,
    resolveTools,
  };
}

/**
 * Recipes shipped with GhostShell. Their integrity hashes are over
 * `canonicalRecipe`; run `computeIntegrity` to recompute one after editing.
 */
export const BUILTIN_RECIPES: Recipe[] = [
  {
    name: 'django-debugger',
    version: '1.0.0',
    description: 'Debug Django apps with logging, shell, and test isolation.',
    license: 'MIT',
    author: 'ghostshell',
    prompt: 'You are debugging a Django application. Prefer `manage.py shell` and test isolation.',
    tools: ['bash', 'read_file', 'write_file', 'search'],
    setup: 'echo "django-debugger installed"',
    integrity: { sha256: '2b3e6115c95ab8d4493987ab6f3cb64257a4e1a149eca98008f142a8bd305b23' },
  },
];

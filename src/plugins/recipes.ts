import type { Recipe, ToolContext } from '@/types/index.js';

/**
 * Recipe / skill packages.
 *
 * A recipe bundles a prompt fragment, tool allowlist, setup script, and evals.
 * Install = verify sha256 -> run setup.sh in the VM -> merge prompt -> register
 * tools. See docs/CREATIVE_INNOVATION.md §3.2.
 */

export interface RecipeManager {
  list(): Recipe[];
  install(recipe: Recipe, ctx: ToolContext): Promise<void>;
  uninstall(name: string): Promise<void>;
  verify(recipe: Recipe): Promise<boolean>;
}

export function createRecipeManager(): RecipeManager {
  const installed = new Map<string, Recipe>();
  return {
    list: () => [...installed.values()],
    async install(recipe, ctx) {
      if (!(await this.verify(recipe))) throw new Error(`Integrity check failed: ${recipe.name}`);
      await ctx.vm.exec(`cat > /tmp/recipe-setup.sh <<'EOF'\n${recipe.setup}\nEOF\nbash /tmp/recipe-setup.sh`);
      installed.set(recipe.name, recipe);
    },
    async uninstall(name) {
      installed.delete(name);
    },
    async verify(recipe) {
      // TODO: sha256 of the canonical recipe JSON.
      void recipe;
      return true;
    },
  };
}

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
    integrity: { sha256: '' },
  },
];

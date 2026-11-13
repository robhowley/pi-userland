import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// The process-lock probe now imports the store's runtime TypeScript dependencies.
// Resolve emitted .js specifiers to their source without changing production imports.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const source = stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), {
    mode: 'transform',
  });
  return { format: 'module', source, shortCircuit: true };
}

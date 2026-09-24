import { join } from 'node:path'

/**
 * Where the built widget HTML lives. build.mjs writes it to src/widgets/dist,
 * the directory package.json "files" ships. This code runs from src/widgets
 * under tsx and vitest, and from build/widgets once compiled; both sit two
 * levels below the package root, so one relative path reaches it from either.
 */
export function widgetDistDir(moduleDir: string): string {
  return join(moduleDir, '..', '..', 'src', 'widgets', 'dist')
}

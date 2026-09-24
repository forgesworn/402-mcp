import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { widgetDistDir } from '../src/widgets/paths.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shipped = join(root, 'src', 'widgets', 'dist')

describe('widgetDistDir', () => {
  it('reaches the built widgets from source and from the compiled build', () => {
    expect(widgetDistDir(join(root, 'src', 'widgets'))).toBe(shipped)
    expect(widgetDistDir(join(root, 'build', 'widgets'))).toBe(shipped)
  })

  it('points at a directory the package ships', () => {
    const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] }
    expect(files).toContain('src/widgets/dist')
  })
})

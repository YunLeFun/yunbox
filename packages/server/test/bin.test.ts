import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('package bin', () => {
  it('registers yunbox-server', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> }
    expect(manifest.bin).toEqual({ 'yunbox-server': './dist/cli.mjs' })
  })
})

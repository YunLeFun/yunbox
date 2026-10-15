import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli.ts',
  ],
  platform: 'node',
  target: 'node22',
  format: 'esm',
  dts: true,
  exports: true,
})

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
  exports: {
    // Without an explicit name tsdown derives the bin from the unscoped package name (`server`).
    bin: {
      'yunbox-server': './src/cli.ts',
    },
  },
})

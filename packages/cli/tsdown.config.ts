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
    // One entry under two names: Git runs `git-yunbox` for `git yunbox ...`.
    bin: {
      'git-yunbox': './src/cli.ts',
      'yunbox': './src/cli.ts',
    },
  },
})

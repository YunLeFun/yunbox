// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
    pnpm: true,
    ignores: [
      '**/dist/**',
      '**/.build/**',
      '**/.swiftpm/**',
      'coverage/**',
      // Icon Composer documents keep Apple's formatting and are SHA-256 pinned.
      '**/*.icon/**',
    ],
  },
)

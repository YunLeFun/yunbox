import { defineConfig } from 'bumpp'
import { releaseFiles } from './script/changelog.mjs'

export default defineConfig({
  files: ['packages/cli/package.json'],
  // The pending changelog notes become this version's, in the same commit.
  execute(operation) {
    operation.state.updatedFiles.push(...releaseFiles(operation.state.newVersion))
  },
})

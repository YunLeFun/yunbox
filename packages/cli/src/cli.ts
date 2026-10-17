#!/usr/bin/env node
// @env node

import process from 'node:process'
import { runCli } from './run.ts'

// Installed twice, as `yunbox` and as `git-yunbox` (which Git runs for
// `git yunbox ...`); both names behave the same.
process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
})

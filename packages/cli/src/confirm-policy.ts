import type { CliContext } from './context.ts'
import { readGitConfig } from './git.ts'
import { InspectionError } from './inspect-git.ts'

/** When an enabled confirmation hook asks: by default only for exceeded budgets. */
export async function readConfirmMode(context: CliContext): Promise<'exceeded' | 'always'> {
  const value = await readGitConfig(context, 'yunbox.confirmMode')
  if (value === undefined || value === 'exceeded')
    return 'exceeded'
  if (value === 'always')
    return 'always'
  throw new InspectionError('yunbox.confirmMode 只能是 exceeded 或 always')
}

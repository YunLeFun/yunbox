import type { TypesReport } from '../src/commands/types.ts'
import type { Sandbox } from './helpers.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const LFS = 'filter=lfs diff=lfs merge=lfs -text'
const sandboxes: Sandbox[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

async function setup(): Promise<{ sandbox: Sandbox, repo: string }> {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  // Behave like Linux and CI everywhere: macOS and Windows default to core.ignorecase=true.
  await git(sandbox, repo, 'config', 'core.ignorecase', 'false')
  return { sandbox, repo }
}

async function commitFiles(sandbox: Sandbox, repo: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, '..'), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  await git(sandbox, repo, 'add', '--', ...Object.keys(files))
  await git(sandbox, repo, 'commit', '--quiet', '-m', message)
}

async function listTypes(sandbox: Sandbox, repo: string): Promise<TypesReport> {
  const result = await runYunBox(sandbox, repo, ['types', '--json'])
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout) as TypesReport
}

function category(report: TypesReport, id: string): TypesReport['categories'][number] {
  return report.categories.find(category => category.id === id)!
}

function extension(report: TypesReport, id: string, name: string): TypesReport['categories'][number]['extensions'][number] {
  return category(report, id).extensions.find(row => row.extension === name)!
}

describe('yunbox types', () => {
  it('lists which types go through LFS, file counts and plain files, including upper-case extensions', async () => {
    const { sandbox, repo } = await setup()
    const empty = await listTypes(sandbox, repo)
    expect(empty.schemaVersion).toBe(1)
    expect(empty.categories.every(category => category.state === 'none')).toBe(true)
    expect(empty.presets.map(preset => preset.id)).toEqual(['game', 'design', 'media', 'all'])

    await writeFile(join(repo, '.gitattributes'), `*.wav ${LFS}\n`)
    expect((await runYunBox(sandbox, repo, ['types', 'add', 'texture'])).code).toBe(0)
    await git(sandbox, repo, 'add', '.gitattributes')
    await commitFiles(sandbox, repo, { 'ui/a.png': 'png', 'hit.wav': 'wav' }, 'lfs files')
    await commitFiles(sandbox, repo, { 'HERO.PNG': 'upper', 'build/pack.zip': 'zip', 'notes.txt': 'text' }, 'plain files')

    const report = await listTypes(sandbox, repo)
    expect(category(report, 'texture').state).toBe('lfs')
    expect(extension(report, 'texture', 'png')).toEqual({ extension: 'png', pattern: '*.png', lfs: true, managed: true, files: 2, lfsFiles: 1 })
    expect(category(report, 'audio').state).toBe('partial')
    expect(extension(report, 'audio', 'wav')).toMatchObject({ lfs: true, managed: false, files: 1, lfsFiles: 1 })
    expect(extension(report, 'audio', 'mp3')).toMatchObject({ lfs: false, managed: false, files: 0 })
    expect(category(report, 'archive').state).toBe('none')
    expect(report.plainFiles).toEqual([
      { path: 'HERO.PNG', category: 'texture', extension: 'PNG', reason: 'case' },
      { path: 'build/pack.zip', category: 'archive', extension: 'zip', reason: 'no-rule' },
    ])

    const text = await runYunBox(sandbox, repo, ['types'])
    expect(text.code).toBe(0)
    expect(text.stdout).toMatch(/✓ texture .*全部走 LFS；文件 2 个，LFS 指针 1 个/)
    expect(text.stdout).toMatch(/~ audio .*1\/9 走 LFS.*（1 条来自其他规则）/)
    expect(text.stdout).toContain('HERO.PNG：扩展名大小写不同')
    expect(text.stdout).toContain('git yunbox types add archive --renormalize')
    expect(text.stdout).toContain('git lfs track \'*.PNG\'')

    // A rule added after the file was committed: the file shows as modified until renormalized.
    await git(sandbox, repo, 'config', 'core.ignorecase', 'true')
    expect((await listTypes(sandbox, repo)).plainFiles[0]).toEqual({ path: 'HERO.PNG', category: 'texture', extension: 'PNG', reason: 'not-renormalized' })
  })

  it('adds types and presets, skipping rules that would catch plain files unless --renormalize is given', async () => {
    const { sandbox, repo } = await setup()
    await commitFiles(sandbox, repo, { 'build/pack.zip': 'zip', 'docs/[draft].zip': 'zip', 'a.7z': '7z' }, 'plain files')

    const design = await runYunBox(sandbox, repo, ['types', 'add', 'design'])
    expect(design.code).toBe(0)
    const attributes = await readFile(join(repo, '.gitattributes'), 'utf8')
    for (const pattern of ['*.png', '*.psd', '*.ttf'])
      expect(attributes).toContain(`${pattern} `)
    expect(attributes).not.toContain('*.fbx')

    const skipped = await runYunBox(sandbox, repo, ['types', 'add', 'archive'])
    expect(skipped.code).toBe(0)
    expect(skipped.stdout).toContain('*.zip（build/pack.zip 等 2 个）')
    expect(skipped.stdout).toContain('git yunbox types add archive --renormalize')
    let current = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(current).toContain('*.rar')
    expect(current).not.toContain('*.zip')
    expect(current).not.toContain('*.7z')
    expect(await git(sandbox, repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')

    const moved = await runYunBox(sandbox, repo, ['types', 'add', 'archive', '--renormalize'])
    expect(moved.code).toBe(0)
    expect(moved.stdout).toContain('3 个已提交的文件改存为 LFS 指针')
    current = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(current.match(/^# 压缩包$/gm)).toHaveLength(2)
    expect(current).toMatch(/^\*\.zip +filter=lfs/m)
    expect(await git(sandbox, repo, 'diff', '--cached', '--name-only')).toBe('.gitattributes\na.7z\nbuild/pack.zip\ndocs/[draft].zip')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'archives in LFS')
    expect(await git(sandbox, repo, 'lfs', 'ls-files', '--name-only')).toBe('a.7z\nbuild/pack.zip\ndocs/[draft].zip')
    expect(await git(sandbox, repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect((await listTypes(sandbox, repo)).plainFiles).toEqual([])

    // Nothing left to do: the second run changes nothing.
    const again = await runYunBox(sandbox, repo, ['types', 'add', 'archive', '--renormalize'])
    expect(again.stdout).toContain('已包含全部素材规则，未修改')
    expect(again.stdout).toContain('没有需要改存为 LFS 的已提交文件')
  })

  it('removes only the rules YunBox generated and explains what to do with LFS pointers', async () => {
    const { sandbox, repo } = await setup()
    const handWritten = `# project\r\n*.wav ${LFS}\r\n`
    await writeFile(join(repo, '.gitattributes'), handWritten)
    expect((await runYunBox(sandbox, repo, ['types', 'add', 'audio,texture'])).code).toBe(0)
    // git lfs track appends right after the block (and drops blank lines).
    await git(sandbox, repo, 'lfs', 'track', '*.blend')
    await commitFiles(sandbox, repo, { 'hit.ogg': 'ogg', 'hit.wav': 'wav', 'a.png': 'png' }, 'assets')
    const before = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(before.replaceAll('\r\n', '')).not.toContain('\n')

    const audio = await runYunBox(sandbox, repo, ['types', 'remove', 'audio'])
    expect(audio.code).toBe(0)
    expect(audio.stdout).toContain('删除 8 条规则（音频 8）')
    expect(audio.stdout).toContain('1 个已提交的文件是 LFS 指针')
    expect(audio.stdout).toContain('hit.ogg')
    expect(audio.stdout).not.toContain('hit.wav')
    expect(audio.stdout).toContain('git add --renormalize .')
    expect(audio.stdout).toContain('仍由其他规则（手写或 git lfs track）走 LFS，未改动：*.wav')
    const afterAudio = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(afterAudio.startsWith(handWritten)).toBe(true)
    expect(afterAudio).not.toContain('*.ogg')
    expect(afterAudio).toContain('*.png')
    expect(afterAudio).toContain('*.blend filter=lfs')
    expect(await git(sandbox, repo, 'check-attr', 'filter', '--', 'hit.wav', 'hit.ogg')).toBe('hit.wav: filter: lfs\nhit.ogg: filter: unspecified')
    // The pointer stays in the index untouched.
    expect(await git(sandbox, repo, 'lfs', 'ls-files', '--name-only')).toContain('hit.ogg')

    const texture = await runYunBox(sandbox, repo, ['types', 'remove', 'texture'])
    expect(texture.code).toBe(0)
    expect(await readFile(join(repo, '.gitattributes'), 'utf8')).toBe(`${handWritten}*.blend ${LFS}\r\n`)

    const nothing = await runYunBox(sandbox, repo, ['types', 'remove', 'model'])
    expect(nothing.code).toBe(0)
    expect(nothing.stdout).toContain('没有 YunBox 为模型和动画生成的规则，未修改')
    expect(nothing.stdout).toContain('*.blend')
  })

  it('rejects bad usage and reports errors as JSON', async () => {
    const { sandbox, repo } = await setup()
    const cases: Array<[string[], RegExp]> = [
      [['types', 'add'], /至少一个类型/],
      [['types', 'add', 'texture,nope'], /未知的素材类型：nope/],
      [['types', 'remove', 'texture', '--renormalize'], /remove 不接受 --renormalize/],
      [['types', 'list', 'texture'], /不接受类型参数/],
      [['types', 'rename'], /未知子命令/],
    ]
    for (const [argv, message] of cases) {
      const result = await runYunBox(sandbox, repo, argv)
      expect(result.code, argv.join(' ')).toBe(2)
      expect(result.stderr).toMatch(message)
    }
    const outside = await runYunBox(sandbox, sandbox.root, ['types', '--json'])
    expect(outside.code).toBe(1)
    expect(JSON.parse(outside.stdout)).toEqual({ schemaVersion: 1, status: 'error', error: { code: 'TYPES_FAILED', message: '当前目录不在 Git 仓库里' } })
    expect((await runYunBox(sandbox, repo, ['help', 'types'])).stdout).toContain('预置组合')
  })
})

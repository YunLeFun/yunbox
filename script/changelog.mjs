// The changelog in two languages: docs/changelog.md (Simplified Chinese) and
// docs/en/changelog.md (English). Both list the same versions; each has an
// "unreleased" section on top that collects changes until the next release.
// The docs site shows them, GitHub releases quote them, and the macOS app's
// update prompt shows the section in the interface language.
//
//   node script/changelog.mjs check [--unreleased]   validate; --unreleased also requires pending notes
//   node script/changelog.mjs release <version> [date]   turn the unreleased notes into <version>
//   node script/changelog.mjs notes <version|unreleased> <zh|en>   print one section
//   node script/changelog.mjs github <version>   the GitHub release body
//   node script/changelog.mjs appcast <appcast.xml> <version|unreleased>   embed both languages in a Sparkle appcast
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The two changelogs, keyed by the language code the app and Sparkle use. */
export const LANGUAGES = {
  'zh-Hans': { file: 'docs/changelog.md', unreleased: '未发布' },
  'en': { file: 'docs/en/changelog.md', unreleased: 'Unreleased' },
}

/** Short names accepted on the command line. */
const ALIASES = { zh: 'zh-Hans', en: 'en' }

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+(?:-[\w.]+)?) - (\d{4}-\d{2}-\d{2})$/

/**
 * Split a changelog into its intro and `## ` sections.
 *
 * @param {string} text Markdown of one changelog
 * @param {string} unreleased The heading of the pending section in this language
 * @returns {{ intro: string, unreleased: string, releases: { version: string, date: string, body: string }[] }} The parts
 */
export function parse(text, unreleased) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const first = lines.findIndex(line => line.startsWith('## '))
  if (first < 0 || lines[first] !== `## ${unreleased}`)
    throw new Error(`the first section must be "## ${unreleased}"`)
  const sections = []
  for (const [index, line] of lines.entries()) {
    if (index >= first && line.startsWith('## '))
      sections.push({ heading: line, lines: [] })
    else if (index > first)
      sections.at(-1).lines.push(line)
  }
  const releases = sections.slice(1).map(({ heading, lines }) => {
    const match = RELEASE_HEADING.exec(heading)
    if (!match)
      throw new Error(`"${heading}" is not "## <version> - <YYYY-MM-DD>"`)
    const body = lines.join('\n').trim()
    if (body === '')
      throw new Error(`${match[1]} has no notes`)
    return { version: match[1], date: match[2], body }
  })
  const versions = releases.map(release => release.version)
  const duplicate = versions.find((version, index) => versions.indexOf(version) !== index)
  if (duplicate)
    throw new Error(`${duplicate} appears twice`)
  return { intro: lines.slice(0, first).join('\n').trimEnd(), unreleased: sections[0].lines.join('\n').trim(), releases }
}

/**
 * Write the parts back in the canonical layout.
 *
 * @param {ReturnType<typeof parse>} changelog The parts
 * @param {string} unreleased The heading of the pending section
 * @returns {string} Markdown
 */
export function format(changelog, unreleased) {
  const sections = [`## ${unreleased}${changelog.unreleased ? `\n\n${changelog.unreleased}` : ''}`]
  for (const release of changelog.releases)
    sections.push(`## ${release.version} - ${release.date}\n\n${release.body}`)
  return `${changelog.intro}\n\n${sections.join('\n\n')}\n`
}

/**
 * Read and parse every language.
 *
 * @param {string} [base] Repository root
 * @returns {Record<string, ReturnType<typeof parse>>} Changelogs by language
 */
export function load(base = root) {
  return Object.fromEntries(Object.entries(LANGUAGES).map(([language, { file, unreleased }]) => {
    try {
      return [language, parse(readFileSync(path.join(base, file), 'utf8'), unreleased)]
    }
    catch (error) {
      throw new Error(`${file}: ${error.message}`)
    }
  }))
}

/**
 * Check that every language lists the same releases, in the same order and on the same dates.
 *
 * @param {Record<string, ReturnType<typeof parse>>} changelogs Changelogs by language
 * @param {{ unreleased?: boolean }} [options] With `unreleased`, every language must have pending notes
 */
export function check(changelogs, { unreleased = false } = {}) {
  const [[firstLanguage, first], ...others] = Object.entries(changelogs)
  const list = changelog => changelog.releases.map(release => `${release.version} - ${release.date}`).join(', ')
  for (const [language, changelog] of others) {
    if (list(changelog) !== list(first))
      throw new Error(`${LANGUAGES[language].file} lists ${list(changelog) || 'no releases'}, but ${LANGUAGES[firstLanguage].file} lists ${list(first) || 'no releases'}`)
  }
  if (unreleased) {
    for (const [language, changelog] of Object.entries(changelogs)) {
      if (changelog.unreleased === '')
        throw new Error(`${LANGUAGES[language].file}: write the changes under "## ${LANGUAGES[language].unreleased}" before releasing`)
    }
  }
}

/**
 * Turn the pending notes of every language into `version`.
 *
 * @param {Record<string, ReturnType<typeof parse>>} changelogs Changelogs by language
 * @param {string} version The new version, e.g. 0.2.0
 * @param {string} date YYYY-MM-DD
 * @returns {Record<string, ReturnType<typeof parse>>} The updated changelogs
 */
export function release(changelogs, version, date) {
  check(changelogs, { unreleased: true })
  if (Object.values(changelogs)[0].releases.some(entry => entry.version === version))
    throw new Error(`${version} is already in the changelog`)
  return Object.fromEntries(Object.entries(changelogs).map(([language, changelog]) => [language, {
    ...changelog,
    unreleased: '',
    releases: [{ version, date, body: changelog.unreleased }, ...changelog.releases],
  }]))
}

/**
 * Release the pending notes of the repository's changelogs as `version` and write them back.
 *
 * @param {string} version The new version
 * @param {string} [date] YYYY-MM-DD, today by default
 * @returns {string[]} The changed files, relative to the repository root
 */
export function releaseFiles(version, date = today()) {
  for (const [language, changelog] of Object.entries(release(load(), version, date)))
    writeFileSync(path.join(root, LANGUAGES[language].file), format(changelog, LANGUAGES[language].unreleased))
  return Object.values(LANGUAGES).map(({ file }) => file)
}

/**
 * The notes of one version (or the pending ones) in one language.
 *
 * @param {Record<string, ReturnType<typeof parse>>} changelogs Changelogs by language
 * @param {string} version A version, or "unreleased"
 * @param {string} language A key of LANGUAGES
 * @returns {string} Markdown without the version heading
 */
export function notes(changelogs, version, language) {
  const changelog = changelogs[language]
  if (!changelog)
    throw new Error(`unknown language ${language}`)
  const body = version === 'unreleased' ? changelog.unreleased : changelog.releases.find(entry => entry.version === version)?.body
  if (!body)
    throw new Error(`${LANGUAGES[language].file} has no notes for ${version}`)
  return body
}

/**
 * Put the notes of every language into the single update item of a Sparkle appcast as
 * `<description xml:lang="…" sparkle:format="markdown">`; Sparkle shows the one matching the
 * app's language. Removes the feed signature, which no longer matches: sign the file again.
 *
 * @param {string} xml The appcast generate_appcast wrote
 * @param {Record<string, string>} notesByLanguage Markdown by language
 * @returns {string} The appcast with the descriptions
 */
export function embedInAppcast(xml, notesByLanguage) {
  if ((xml.match(/<item>/g) ?? []).length !== 1)
    throw new Error('expected an appcast with exactly one <item>')
  const descriptions = Object.entries(notesByLanguage).map(([language, markdown]) => {
    if (markdown.includes(']]>'))
      throw new Error(`the ${language} notes contain "]]>", which cannot go into CDATA`)
    return `            <description xml:lang="${language}" sparkle:format="markdown"><![CDATA[${markdown}\n]]></description>`
  })
  return xml
    .replace(/<!-- sparkle-signatures:[\s\S]*?-->\s*$/, '')
    .replace(/\s*<description\b[\s\S]*?<\/description>/g, '')
    .replace(/(\n\s*)<enclosure\b/, `\n${descriptions.join('\n')}$1<enclosure`)
}

/**
 * Today's date where the release is made, as YYYY-MM-DD.
 *
 * @returns {string} The date
 */
function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function main([command, ...args]) {
  const changelogs = load()
  switch (command) {
    case 'check':
      check(changelogs, { unreleased: args.includes('--unreleased') })
      process.stdout.write(`${Object.values(LANGUAGES).map(({ file }) => file).join(' and ')} list the same ${changelogs['zh-Hans'].releases.length} releases\n`)
      break
    case 'release':
      if (!args[0])
        throw new Error('usage: release <version> [YYYY-MM-DD]')
      releaseFiles(args[0], args[1])
      break
    case 'notes':
      process.stdout.write(`${notes(changelogs, args[0], ALIASES[args[1]] ?? args[1])}\n`)
      break
    case 'github': {
      const version = args[0]
      const zh = notes(changelogs, version, 'zh-Hans')
      const en = notes(changelogs, version, 'en')
      process.stdout.write(`${zh}\n\n---\n\n${en}\n\n[更新日志 / Changelog](https://yunlefun.github.io/yunbox/changelog)\n`)
      break
    }
    case 'appcast': {
      const [file, version] = args
      const notesByLanguage = Object.fromEntries(Object.keys(LANGUAGES).map(language => [language, notes(changelogs, version, language)]))
      writeFileSync(file, embedInAppcast(readFileSync(file, 'utf8'), notesByLanguage))
      break
    }
    default:
      throw new Error('usage: changelog.mjs check | release | notes | github | appcast')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  }
  catch (error) {
    console.error(`changelog: ${error.message}`)
    process.exit(1)
  }
}

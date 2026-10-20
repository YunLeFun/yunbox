// Fails when a string in the catalog has no English translation or is no
// longer used by the sources (xcstringstool marks those "stale"). With a
// second catalog, also fails when the two hold different strings: the CI check
// syncs a copy and compares the strings rather than the bytes, which another
// Xcode may format differently.
//   node script/check_strings.mjs <Localizable.xcstrings> [committed.xcstrings]
import { readFileSync } from 'node:fs'
import process from 'node:process'

const catalog = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const problems = []
if (process.argv[3]) {
  const committed = new Set(Object.keys(JSON.parse(readFileSync(process.argv[3], 'utf8')).strings))
  for (const key of Object.keys(catalog.strings)) {
    if (!committed.has(key))
      problems.push(`not in the committed catalog: ${JSON.stringify(key)}`)
  }
}
for (const [key, entry] of Object.entries(catalog.strings)) {
  if (entry.extractionState === 'stale')
    problems.push(`no longer used: ${JSON.stringify(key)}`)
  else if (entry.shouldTranslate !== false && !translated(entry.localizations?.en))
    problems.push(`missing English: ${JSON.stringify(key)}`)
}
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
process.stdout.write(`${Object.keys(catalog.strings).length} strings, all translated\n`)

function translated(localization) {
  if (localization === undefined)
    return false
  if (localization.stringUnit !== undefined)
    return localization.stringUnit.state === 'translated'
  const variants = Object.values(localization.variations ?? {}).flatMap(group => Object.values(group))
  return variants.length > 0 && variants.every(translated)
}

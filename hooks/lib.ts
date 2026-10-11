// Pure helpers for skill-coach: no `$` here, so the tests can call them directly.

/** An installed skill or command the prompt could use. */
export type Skill = {
  name: string
  description: string
}

/** A plugin the person could install: `id` is what `claude plugin install` takes. */
export type Installable = {
  id: string
  name: string
  marketplace: string
  description: string
}

/** A word index over one entry, for the quick local ranking. */
export type Indexed = {
  terms: ReadonlySet<string>
  nameTerms: ReadonlySet<string>
  length: number
}

export type Index<T> = {
  items: ReadonlyArray<T & Indexed>
  idf: ReadonlyMap<string, number>
  avgLength: number
}

export type Catalog = Index<Installable> & {
  loadedAt: number
  from: 'cli' | 'files'
}

export type Suggestion = { id: string; why: string }

export type Fine = { verdict: 'fine'; install: Suggestion[] }

export type Improve = {
  verdict: 'improve'
  why: string
  skills: string[]
  install: Suggestion[]
  prompt: string
}

export type Verdict = Fine | Improve

/** Short replies and commands that never need a check. */
export const SKIP =
  /^\s*([/!#]|(y|yes|yep|yeah|no|n|nope|ok|okay|k|sure|go|go on|go ahead|continue|proceed|thanks|thank you|thx|do it|lgtm|stop|done|next|retry|try again)\b[.!]?\s*$)/i

const STOP = new Set(
  (
    'the and for with that this these those from into your you are was were will would should could can ' +
    'please make sure just also then than them they their there here what when where which while who why how ' +
    'all any some more most much many each every other only own same such very too not but our out has have had ' +
    'does did doing get got its use using used want need like let lets one two now way about after before over ' +
    'under again once off onto upon via per still yet thing things stuff help able'
  ).split(' '),
)

/** A rough stem, so "charts" meets "chart" and "testing" meets "test". */
export function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 4 && /(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/** The meaningful words of a text, lowercased and stemmed. */
export function words(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOP.has(raw)) continue
    out.push(stem(raw))
  }
  return out
}

/** Indexes entries by the words of their name and description. */
export function index<T extends { name: string; description: string }>(list: readonly T[]): Index<T> {
  const items = list.map(entry => {
    const nameWords = words(entry.name.replace(/[-_.:/]/g, ' '))
    const all = new Set([...nameWords, ...words(entry.description)])
    return { ...entry, terms: all, nameTerms: new Set(nameWords), length: Math.max(1, all.size) }
  })
  const seenIn = new Map<string, number>()
  for (const item of items) for (const term of item.terms) seenIn.set(term, (seenIn.get(term) ?? 0) + 1)
  const n = Math.max(1, items.length)
  const idf = new Map<string, number>()
  for (const [term, count] of seenIn) idf.set(term, Math.log(1 + n / count))
  const avgLength = items.reduce((sum, item) => sum + item.length, 0) / n || 1

  return { items, idf, avgLength }
}

/**
 * The entries that share the most specific words with the query, best first.
 * An entry must share two words when the query has two or more, so one common
 * word in a name (a "bar", a "fix") is not enough. A word in the name counts
 * half again; long descriptions are evened out; covering more of the query wins.
 */
export function rank<T>(query: readonly string[], index: Index<T>, limit: number, minScore = 0): Array<T & Indexed> {
  const unique = [...new Set(query)]
  const minHits = Math.min(2, unique.length)
  const scored: Array<{ item: T & Indexed; score: number }> = []
  for (const item of index.items) {
    let score = 0
    let hits = 0
    for (const term of unique) {
      if (!item.terms.has(term)) continue
      hits++
      score += (index.idf.get(term) ?? 1) * (item.nameTerms.has(term) ? 1.5 : 1)
    }
    if (hits === 0 || hits < minHits) continue
    score /= 0.5 + (0.5 * item.length) / index.avgLength
    score *= Math.sqrt(hits / unique.length)
    if (score >= minScore) scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(entry => entry.item)
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value

/** The JSON object in a text that may have words before or after it. */
function objectIn(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(raw.slice(start, end + 1))
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** `claude plugin list --available --json`: the plugins not installed yet. */
export function parseAvailable(stdout: string): Installable[] {
  const data = objectIn(stdout)
  if (data === undefined) return []
  const installed = new Set<string>()
  for (const entry of Array.isArray(data.installed) ? data.installed : []) {
    const id = text((entry as { id?: unknown } | null)?.id)
    if (id !== '') installed.add(id)
  }
  const out: Installable[] = []
  for (const entry of Array.isArray(data.available) ? data.available : []) {
    const record = (entry ?? {}) as Record<string, unknown>
    const id = text(record.pluginId)
    if (id === '' || installed.has(id)) continue
    const [name = id, marketplace = ''] = id.split('@')
    out.push({
      id,
      name: text(record.name) || name,
      marketplace: text(record.marketplaceName) || marketplace,
      description: clip(text(record.description), 300),
    })
  }

  return out
}

/** One marketplace's `.claude-plugin/marketplace.json`. */
export function pluginsFromMarketplace(marketplace: string, json: string): Installable[] {
  const data = objectIn(json)
  const out: Installable[] = []
  for (const entry of Array.isArray(data?.plugins) ? data.plugins : []) {
    const record = (entry ?? {}) as Record<string, unknown>
    const name = text(record.name)
    if (name === '') continue
    out.push({ id: `${name}@${marketplace}`, name, marketplace, description: clip(text(record.description), 300) })
  }

  return out
}

/** The plugin directory's local cache (`plugin-directory-cache-v2.json`). */
export function pluginsFromDirectoryCache(json: string): Installable[] {
  const data = objectIn(json)
  if (data === undefined) return []
  const names = (data.entryNames ?? {}) as Record<string, unknown>
  const out: Installable[] = []
  for (const entry of Array.isArray(data.listings) ? data.listings : []) {
    const record = (entry ?? {}) as Record<string, unknown>
    const name = text(names[text(record.id)])
    if (name === '') continue
    out.push({
      id: `${name}@anthropic-plugin-directory`,
      name,
      marketplace: 'anthropic-plugin-directory',
      description: clip(text(record.summary), 300),
    })
  }

  return out
}

/** The ids `installed_plugins.json` lists. */
export function installedIds(json: string): Set<string> {
  const data = objectIn(json)
  const plugins = data?.plugins

  return new Set(typeof plugins === 'object' && plugins !== null ? Object.keys(plugins) : [])
}

/** Share of the prompt's meaningful words the rewrite kept; low means replaced, not improved. */
export function keptShare(prompt: string, rewrite: string): number {
  const of = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []
  const original = new Set(of(prompt))
  if (original.size < 3) return 1
  const kept = new Set(of(rewrite))
  let hits = 0
  for (const word of original) if (kept.has(word)) hits++

  return hits / original.size
}

/** How many new meaningful words the rewrite adds: a fix of one typo adds one. */
export function addedWords(prompt: string, rewrite: string): number {
  const of = (value: string) => new Set(value.toLowerCase().match(/[\p{L}\p{N}_./:-]{4,}/gu) ?? [])
  const original = of(prompt)
  let added = 0
  for (const word of of(rewrite)) if (!original.has(word)) added++

  return added
}

const squash = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The model's answer, checked: skills must be installed ones, installs must be
 * among the candidates, and a rewrite must keep the person's own words.
 */
export function parseVerdict(
  raw: string,
  prompt: string,
  skills: readonly Skill[],
  candidates: readonly Installable[],
): Verdict | undefined {
  const data = objectIn(raw)
  if (data === undefined) return undefined

  const ids = new Set(candidates.map(plugin => plugin.id))
  const install: Suggestion[] = []
  for (const entry of Array.isArray(data.install) ? data.install : []) {
    const record = typeof entry === 'string' ? { id: entry } : ((entry ?? {}) as Record<string, unknown>)
    const id = text(record.id).trim()
    if (!ids.has(id) || install.some(s => s.id === id)) continue
    install.push({ id, why: clip(text(record.why).trim(), 80) })
    if (install.length === 2) break
  }

  const byName = new Map(skills.map(skill => [skill.name.toLowerCase(), skill.name]))
  const picked: string[] = []
  for (const entry of Array.isArray(data.skills) ? data.skills : []) {
    const name = byName.get(text(entry).replace(/^[\s`/]+|[\s`]+$/g, '').toLowerCase())
    if (name !== undefined && !picked.includes(name)) picked.push(name)
    if (picked.length === 3) break
  }

  const rewrite = text(data.prompt).trim()
  const isImproved =
    data.verdict === 'improve' &&
    rewrite !== '' &&
    squash(rewrite) !== squash(prompt) &&
    keptShare(prompt, rewrite) >= 0.5 &&
    // with no skill to name, a rewrite that adds a word or two is not worth the interruption
    (picked.length > 0 || addedWords(prompt, rewrite) >= 3)
  if (!isImproved) return { verdict: 'fine', install }

  return { verdict: 'improve', why: clip(text(data.why).trim(), 100), skills: picked, install, prompt: rewrite }
}

export const SYSTEM = `You help a developer send better prompts to Claude Code, an AI coding agent, BEFORE the prompt is sent.
You get their new prompt, the recent conversation, the skills and commands they have installed, and some plugins they could install.

Decide two things.
1. Skills. Which installed skills clearly fit this request? Pick at most 3, by their exact names from the list. Most prompts need no skill: pick none rather than a weak fit.
   Plugins to install: suggest at most 2, by their exact ids, and only when no installed skill already covers the request and the plugin clearly fits it.
2. The prompt. Would a clearer version get a better result? Only real problems count: a vague goal, no way to tell when it is done, an unclear target ("fix it") that the conversation explains, several unrelated asks mixed together, or a missing constraint the agent will need.

If you picked installed skills, or found a real problem you can fix, write an improved prompt:
- Keep the person's intent, words, order, voice and language. Make the smallest change that helps.
- Never add requirements, asks or questions they did not make. A bug report stays a bug report, a request stays a request, a question stays a question. Never turn the prompt into a question back to the person.
- Never invent facts (files, errors, names, numbers) that are not in the prompt or the conversation. If making it clearer would need facts you do not have, leave the wording as it is.
- Resolve "it", "this" or "that file" from the conversation when it makes them clear.
- For each installed skill you picked, add one short line that names it exactly, in backticks, for example: Use the \`xlsx\` skill.
- Never mention plugins that are not installed in the prompt.
Each suggestion interrupts the person, so without a skill, only rewrite when the change would clearly change what the agent does; small wording changes are not worth it.
A short reply in an ongoing conversation ("yes", "go ahead", an answer to a question) is fine as it is. When you picked no skill and changed nothing, the verdict is "fine".

Answer ONLY with JSON, no other text:
{"verdict":"fine","install":[]}
or
{"verdict":"improve","why":"<at most 12 words>","skills":["<installed skill name>"],"install":[{"id":"<plugin id>","why":"<at most 8 words>"}],"prompt":"<the improved prompt>"}
"install" may be empty in both. Use "fine" with a non-empty "install" when only a plugin to install would help.`

/** The last few turns, oldest first, cut so the reviewer sees what the prompt refers to. */
export function recentTurns(messages: ReadonlyArray<{ role: string; text: string }>, max = 6, perMessage = 700): string {
  return messages
    .filter(message => message.text.trim() !== '')
    .slice(-max)
    .map(message => {
      const who = message.role === 'user' ? 'User' : 'Agent'
      const body = message.text.length > perMessage ? `…${message.text.slice(-perMessage)}` : message.text
      return `${who}: ${body}`
    })
    .join('\n\n')
}

/** The one user message the reviewing model reads. */
export function buildRequest(args: {
  prompt: string
  project: string
  conversation: string
  skills: readonly Skill[]
  candidates: readonly Installable[]
}): string {
  const skills = args.skills.length > 0
    ? args.skills.map(skill => `- \`${skill.name}\`: ${clip(skill.description, 200) || '(no description)'}`).join('\n')
    : '(none)'
  const candidates = args.candidates.length > 0
    ? args.candidates.map(plugin => `- \`${plugin.id}\`: ${clip(plugin.description, 200) || '(no description)'}`).join('\n')
    : '(none)'

  return [
    `Project folder: ${args.project || '(unknown)'}`,
    `Recent conversation, oldest first (may be empty):\n"""${args.conversation}"""`,
    `Installed skills and commands:\n${skills}`,
    `Plugins they could install:\n${candidates}`,
    `The person's new prompt:\n"""${args.prompt}"""`,
  ].join('\n\n')
}

/** The question the dialog asks: why, which skills, what to install, and the new prompt. */
export function dialogText(verdict: Improve): string {
  const lines = [verdict.why === '' ? 'Skill coach has a clearer prompt.' : `Skill coach: ${verdict.why}`]
  if (verdict.skills.length > 0) lines.push(`Skills it uses: ${verdict.skills.map(name => `/${name}`).join(', ')}`)
  for (const suggestion of verdict.install) {
    lines.push(`Could install: ${suggestion.id}${suggestion.why === '' ? '' : ` (${suggestion.why})`}`)
  }
  lines.push('', verdict.prompt, '', 'Use this prompt?')

  return lines.join('\n')
}

/** The transcript line that says how to install a suggested plugin. */
export function installLine(suggestion: Suggestion): string {
  const why = suggestion.why === '' ? '' : ` (${suggestion.why})`

  return `skill-coach: ${suggestion.id} could help${why}. To install it, run /plugin install ${suggestion.id}, or claude plugin install ${suggestion.id} in a terminal.`
}

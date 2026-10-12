// Pure helpers for skill-coach: no `$` here, so the tests can call them directly.

/** An installed skill or command the prompt could use. */
export type Skill = {
  name: string
  description: string
}

/** The model the session runs, read from what `/model` shows. */
export type ModelInfo = {
  /** What `$.session.model()` answered. */
  raw: string
  /** The store key and the docs slug: `opus-5-5`, or the raw name when it names no Claude family. */
  key: string
  /** How a person names it: `Claude Opus 5.5`. */
  display: string
  family?: string
  /** `5.5`, `4`; absent for a bare alias such as `opus`. */
  version?: string
}

/**
 * What research found, kept across sessions: how to prompt one model
 * (`model:<key>`), or how to prompt for one kind of task (`task:<kind>`).
 */
export type Guide = {
  key: string
  /** What it is about: `Claude Opus 5.5`, `frontend design`. */
  title: string
  text: string
  /** The pages and searches it was distilled from; empty when none could be read. */
  sources: string[]
  at: number
  from: 'docs' | 'knowledge'
}

/** What the prompt asks for, as the analysis read it. */
export type Analysis = {
  /** One line: what the person wants done. */
  task: string
  /** A short kebab-case kind of work, reused across prompts: `frontend-design`, `debugging`. */
  kind: string
  /** Up to three short searches for skills that would help. */
  searches: string[]
  /** A web search about prompting an AI coding agent for this kind of task. */
  question: string
}

/** The rewritten prompt, the installed skills it names, and the online skills (by id) it names. */
export type Rewrite = {
  prompt: string
  skills: string[]
  online: string[]
}

/** An online skill as the rewrite sees it. */
export type OnlineOption = {
  id: string
  skillId: string
  source: string
  /** The line that names it in the prompt. */
  line: string
}

/** Anthropic's index of every docs page, each linked as Markdown. */
export const DOCS_INDEX = 'https://platform.claude.com/llms.txt'
const DOCS_BASE = 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering'
const GENERAL_DOC = `${DOCS_BASE}/claude-prompting-best-practices.md`

/** The Claude Code docs pages every task's research reads: the best practices, the common workflows, the prompt library. */
const CODE_DOCS = 'https://code.claude.com/docs/en'
export const PROMPT_LIBRARY = `${CODE_DOCS}/prompt-library.md`
export const TASK_DOCS = [`${CODE_DOCS}/best-practices.md`, `${CODE_DOCS}/common-workflows.md`, PROMPT_LIBRARY]

/** A guide distilled from the docs is researched again after this long. */
export const DOCS_GUIDE_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** One written from the model's own knowledge (the docs were unreachable) is retried sooner. */
export const KNOWLEDGE_GUIDE_TTL_MS = 24 * 60 * 60 * 1000

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

/** The meaningful words of a text, lowercased and, unless asked not to, stemmed. */
export function words(text: string, isStemmed = true): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (raw.length < 3 || STOP.has(raw)) continue
    out.push(isStemmed ? stem(raw) : raw)
  }
  return out
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
 * A word in the name counts half again; long descriptions are evened out;
 * covering more of the query wins.
 */
export function rank<T>(query: readonly string[], index: Index<T>, limit: number): Array<T & Indexed> {
  const unique = [...new Set(query)]
  const scored: Array<{ item: T & Indexed; score: number }> = []
  for (const item of index.items) {
    let score = 0
    let hits = 0
    for (const term of unique) {
      if (!item.terms.has(term)) continue
      hits++
      score += (index.idf.get(term) ?? 1) * (item.nameTerms.has(term) ? 1.5 : 1)
    }
    if (hits === 0) continue
    score /= 0.5 + (0.5 * item.length) / index.avgLength
    score *= Math.sqrt(hits / unique.length)
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(entry => entry.item)
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

export const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value

const squash = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase()

const FAMILY = '(fable|mythos|opus|sonnet|haiku)'
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** Reads `claude-opus-5-5[1m]`, `Opus 5.5`, `claude-3-5-sonnet-20241022` or a bare `sonnet`. */
export function parseModel(raw: string): ModelInfo {
  const name = raw.toLowerCase().replace(/\[[^\]]*\]/g, ' ').trim()
  // the minor version is one or two digits, so a date suffix is never read as one
  const modern = name.match(new RegExp(`${FAMILY}[\\s-]*(\\d{1,2})(?:[.-](\\d{1,2}))?(?!\\d)`))
  const legacy = name.match(new RegExp(`(\\d)[.-](\\d)[\\s-]*${FAMILY}`))
  const bare = name.match(new RegExp(`^(?:claude[\\s-]*)?${FAMILY}$`))
  const [family, major, minor] = modern
    ? [modern[1], modern[2], modern[3]]
    : legacy
      ? [legacy[3], legacy[1], legacy[2]]
      : bare
        ? [bare[1], undefined, undefined]
        : [undefined, undefined, undefined]
  if (family === undefined) {
    const shown = raw.trim() || 'the session model'
    return { raw, key: squash(shown).replace(/[^a-z0-9.-]+/g, '-'), display: shown }
  }
  const version = major === undefined ? undefined : minor === undefined ? major : `${major}.${minor}`

  return {
    raw,
    key: version === undefined ? family : `${family}-${version.replace('.', '-')}`,
    display: `Claude ${capital(family)}${version === undefined ? '' : ` ${version}`}`,
    family,
    version,
  }
}

/** Every `[title](url)` link of the docs index. */
export function docLinks(index: string): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = []
  for (const [, title = '', url = ''] of index.matchAll(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g)) out.push({ title, url })
  return out
}

const versionValue = (version: string) => {
  const [major = '0', minor = '0'] = version.split('.')
  return Number(major) * 100 + Number(minor)
}

/**
 * The docs pages to research a model from: its own "Prompting Claude <model>"
 * page (the nearest earlier version of its family when it has none), then the
 * best practices every current model shares.
 */
export function pickDocs(index: string, model: ModelInfo): string[] {
  const links = docLinks(index)
  const general = links.find(link => /^prompting best practices$/i.test(link.title.trim()))?.url
  const own = model.family === undefined ? undefined : links
    .map(link => ({ url: link.url, match: link.title.trim().match(new RegExp(`^prompting claude ${FAMILY} (\\d+(?:\\.\\d+)?)$`, 'i')) }))
    .filter(({ match }) => match?.[1]?.toLowerCase() === model.family)
    .map(({ url, match }) => ({ url, value: versionValue(match?.[2] ?? '0') }))
    .filter(page => model.version === undefined || page.value <= versionValue(model.version))
    .sort((a, b) => b.value - a.value)[0]?.url

  return [own, general].filter((url): url is string => url !== undefined)
}

/** The same pages by their usual addresses, for when the index cannot be read. */
export function fallbackDocs(model: ModelInfo): string[] {
  const own = model.family !== undefined && model.version !== undefined
    ? [`${DOCS_BASE}/prompting-claude-${model.key}.md`]
    : []

  return [...own, GENERAL_DOC]
}


/** A value read back from the store, when it is a guide. */
export function asGuide(value: unknown): Guide | undefined {
  const guide = value as Partial<Guide> | null | undefined
  const isGuide =
    typeof guide === 'object' && guide !== null &&
    typeof guide.key === 'string' && typeof guide.title === 'string' && typeof guide.text === 'string' &&
    guide.text.trim() !== '' && typeof guide.at === 'number' && Array.isArray(guide.sources) &&
    (guide.from === 'docs' || guide.from === 'knowledge')

  return isGuide ? (guide as Guide) : undefined
}

/** Whether a stored guide is due to be researched again. */
export function isStale(guide: Guide, now: number): boolean {
  return now - guide.at > (guide.from === 'docs' ? DOCS_GUIDE_TTL_MS : KNOWLEDGE_GUIDE_TTL_MS)
}

export const RESEARCH_SYSTEM = `You research how to prompt one Claude model well, and write a short guide for a single reader: a developer who types a task prompt to that model in Claude Code, an AI coding agent that runs in a terminal or in the Claude desktop app.

The developer writes only the message they send. They do not control the system prompt, API parameters, effort or thinking settings, tools, or the harness. Keep only advice they can apply in the words of that message: how to state the task and its goal, what context and reasons to give, which constraints and scope to set, how to say what done looks like and how to check it, what the model already does well on its own (so the prompt need not ask), and what it must be told explicitly.

Prefer what is specific to this model over general advice, and say where the documentation says this model behaves differently from earlier ones. Leave out API code, parameters, pricing, and anything only a system prompt or harness can do.

Write 8 to 14 bullets, most important first, each one imperative line under 30 words. No title, no preamble, no closing line.`

/** The research request: the model, and the docs pages fetched for it (none when they were unreachable). */
export function researchRequest(model: ModelInfo, docs: ReadonlyArray<{ url: string; text: string }>): string {
  const head = `The model: ${model.display}${model.raw.trim() !== '' && model.raw !== model.display ? ` (${model.raw})` : ''}.`
  if (docs.length === 0) {
    return `${head}\n\nThe documentation could not be fetched. Write the guide from what you know about prompting ${model.display} and the Claude models of its generation.`
  }
  const pages = docs.map(doc => `<doc url="${doc.url}">\n${clip(doc.text, 80_000)}\n</doc>`).join('\n\n')

  return `${head}\n\nAnthropic's documentation about prompting it:\n\n${pages}`
}

/** The guide as the model wrote it, trimmed to the bullets. */
export function cleanGuide(raw: string): string {
  return clip(raw.trim().replace(/^```\w*\n?|\n?```$/g, '').trim(), 4000)
}

export const ANALYZE_SYSTEM = `You read a developer's prompt to Claude Code, an AI coding agent, and say what it asks for, so that it can be improved with research about this kind of task and with skills found online.

Answer ONLY with JSON, no other text:
{"task":"<one line: what they want done, to what>","kind":"<the kind of work, 1 to 3 words in kebab-case>","searches":["<2 to 4 plain words>"],"question":"<a web search query>"}

- task: their goal in their terms; resolve "it" or "this" from the conversation.
- kind: the kind of work, not the project, such as frontend-design, debugging, writing-tests, refactoring, data-analysis, documentation, code-review, api-integration, devops. Reuse one of the known kinds when it fits; coin a new one only when none does.
- searches: 1 to 3 searches of a skills registry, each for a different part of the work (an activity, a framework, a file type), such as "react testing" or "excel charts".
- question: a search for advice on how to prompt an AI coding agent such as Claude Code for this kind of task.`

/** The one user message the analysis reads. */
export function analysisRequest(args: { prompt: string; project: string; conversation: string; kinds: readonly string[] }): string {
  return [
    `Known kinds: ${args.kinds.length > 0 ? args.kinds.join(', ') : '(none yet)'}`,
    `Project folder: ${args.project || '(unknown)'}`,
    `Recent conversation, oldest first (may be empty):\n"""${clip(args.conversation, 3000)}"""`,
    `The prompt:\n"""${args.prompt}"""`,
  ].join('\n\n')
}

/** `Frontend Design!` as `frontend-design`. */
export const kebab = (value: string): string =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

/** The analysis, checked; a plain reading of the prompt's own words when the model gave none. */
export function parseAnalysis(raw: string, prompt: string): Analysis {
  const data = objectIn(raw) ?? {}
  const own = [...new Set(words(prompt, false))].slice(0, 4).join(' ')
  const task = clip(text(data.task).trim(), 200) || clip(prompt.trim().split('\n')[0] ?? '', 200)
  const kind = kebab(text(data.kind)) || 'general'
  const searches = (Array.isArray(data.searches) ? data.searches : [])
    .map(entry => text(entry).replace(/["']/g, '').trim())
    .filter(entry => entry !== '')
    .slice(0, 3)
  const question = text(data.question).trim() || `how to prompt Claude Code for ${kind.replace(/-/g, ' ')}`

  return { task, kind, searches: searches.length > 0 ? searches : own === '' ? [] : [own], question: clip(question, 200) }
}

/** The prompt library's example prompts, one `[category] prompt` line each, out of the page's source. */
export function libraryPrompts(page: string): string {
  const out: string[] = []
  for (const [, category = '', prompt = ''] of page.matchAll(/cat: '([^']*)',[\s\S]*?prompt: '((?:[^'\\]|\\.)*)'/g)) {
    out.push(`[${category}] ${prompt.replace(/\\(.)/g, '$1')}`)
  }

  return out.join('\n')
}

export const TASK_RESEARCH_SYSTEM = `You research how to write a prompt for one kind of task, and write a short guide for one reader: a developer who types a task prompt to Claude Code, an AI coding agent, and wants the best result for this kind of work.

You get Anthropic's Claude Code documentation (its best practices, its common workflows, and example prompts from its prompt library) and the results of a web search about this kind of task. Keep only advice the developer can apply in the words of a prompt for THIS kind of task: what to state, which context and constraints matter here, how to describe done and how the agent should check its own work, which steps or order work best, and which pitfalls to head off. Prefer Anthropic's documentation; use the web results where they add something specific and credible. Skip advice that applies to every prompt alike.

Write 5 to 10 bullets, most important first, each one imperative line under 30 words. Then one line that starts "Example: " with a short prompt for this kind of task, adapted from the prompt library when one fits. No title, no preamble.`

/** The task research request: the kind of task, an example of it, and what was read about it. */
export function taskResearchRequest(args: {
  analysis: Analysis
  docs: ReadonlyArray<{ url: string; text: string }>
  web: string
}): string {
  const pages = args.docs.map(doc => `<doc url="${doc.url}">\n${clip(doc.text, 40_000)}\n</doc>`).join('\n\n')
  const sources = [
    pages === '' ? 'The documentation could not be fetched.' : `Anthropic's Claude Code documentation:\n\n${pages}`,
    args.web === '' ? 'No web search was available.' : `Web search results:\n\n${clip(args.web, 12_000)}`,
  ]

  return [
    `The kind of task: ${args.analysis.kind.replace(/-/g, ' ')}.`,
    `An example of it, the prompt being improved now: ${args.analysis.task}`,
    ...sources,
    pages === '' && args.web === '' ? 'Write the guide from what you know about prompting AI coding agents for this kind of task.' : '',
  ].filter(part => part !== '').join('\n\n')
}

/** The https links a web search's text names, each once. */
export function webUrls(searchText: string, limit = 6): string[] {
  const found = searchText.match(/https:\/\/[^\s"'<>)\]]+/g) ?? []
  return [...new Set(found.map(url => url.replace(/[.,;:]+$/, '')))].slice(0, limit)
}

export function rewriteSystem(model: string): string {
  return `You rewrite a developer's prompt to Claude Code, an AI coding agent, just before it is sent. The session runs ${model}. Turn the prompt into the version that gets the best result from ${model} for this task, and make it use the skills that best fit the task.

You get: a guide to prompting ${model}, researched from Anthropic's documentation; a guide to prompting for this kind of task, researched from Anthropic's Claude Code docs and the web; the installed skills and commands; reliable skills found online for this task, which are not installed (the agent gets the SKILL.md of each one you pick); the recent conversation; the project folder's name; and the prompt.

1. Work out the task: what the person wants done, to what, and how they will know it is done. Use the conversation to resolve "it", "this" or "that error".
2. Pick the skills that clearly help with this task, at most 3 in all. Name an installed skill by its exact name and an online skill by its exact id (owner/repo/skill). Prefer an installed skill; pick an online one where no installed skill covers that part of the work. A skill fits when its description covers part of the work. Pick none rather than a weak fit, and never two that do the same job.
3. Write the prompt so it follows both guides, using only what the person and the conversation said.
4. For each installed skill you picked, add one line that names it in backticks and says what it is for, for example: Use the \`xlsx\` skill to build the workbook. For each online skill you picked, add the line the list gives for it; you may add what it is for.

Rules:
- Keep the person's intent, every fact they gave, and their language. It stays their request to the agent, in their voice.
- Never invent facts: no files, errors, names, numbers, libraries or requirements that are not in the prompt or the conversation. Where a detail is missing, leave it to the agent; never add a question for the person.
- Do not answer the prompt or start the task.
- Keep it as short as the task allows: a one-line task becomes a few lines, not a document. Use a list only when there are several separate parts.
- When the prompt already follows both guides and no skill fits, return it unchanged.

Answer ONLY with JSON, no other text:
{"skills":["<installed skill name or online skill id>"],"prompt":"<the rewritten prompt>"}`
}

/** The last few turns, oldest first, cut so the rewriter sees what the prompt refers to. */
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

/** The one user message the rewriting model reads. */
export function buildRequest(args: {
  model: string
  guide: string
  kind: string
  taskGuide: string
  prompt: string
  project: string
  conversation: string
  skills: readonly Skill[]
  /** One entry per online skill: what it is, and the line that names it. */
  online: ReadonlyArray<{ about: string; line: string }>
}): string {
  const skills = args.skills.length > 0
    ? args.skills.map(skill => `- \`${skill.name}\`: ${clip(skill.description, 200) || '(no description)'}`).join('\n')
    : '(none)'
  const online = args.online.length > 0
    ? args.online.map(skill => `${skill.about}\n  Line to add: ${skill.line}`).join('\n')
    : '(none found)'

  return [
    `How to prompt ${args.model}:\n${args.guide}`,
    `How to prompt for ${args.kind.replace(/-/g, ' ')}:\n${args.taskGuide}`,
    `Project folder: ${args.project || '(unknown)'}`,
    `Recent conversation, oldest first (may be empty):\n"""${args.conversation}"""`,
    `Installed skills and commands:\n${skills}`,
    `Reliable skills found online, not installed:\n${online}`,
    `The person's prompt:\n"""${args.prompt}"""`,
  ].join('\n\n')
}

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

/** Share of the prompt's meaningful words the rewrite kept; low means replaced or answered, not rewritten. */
export function keptShare(prompt: string, rewrite: string): number {
  const of = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []
  const original = new Set(of(prompt))
  if (original.size < 3) return 1
  const kept = new Set(of(rewrite))
  let hits = 0
  for (const word of original) if (kept.has(word)) hits++

  return hits / original.size
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether the prompt names the skill as a word of its own (`xlsx`, /xlsx), not inside another word. */
export function namesSkill(prompt: string, name: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}:-])${escape(name)}(?![\\p{L}\\p{N}:-])`, 'iu').test(prompt)
}

/**
 * The model's answer, checked: skills must be installed ones or online ones
 * that were offered, each is named in the prompt, and the prompt must still be
 * the person's (not replaced or answered). Undefined when there is nothing
 * better to offer.
 */
export function parseRewrite(
  raw: string,
  prompt: string,
  skills: readonly Skill[],
  online: readonly OnlineOption[] = [],
): Rewrite | undefined {
  const data = objectIn(raw)
  if (data === undefined) return undefined

  const byName = new Map(skills.map(skill => [skill.name.toLowerCase(), skill.name]))
  const byId = new Map(online.map(skill => [skill.id.toLowerCase(), skill]))
  // a bare online skill name is taken when it names one offered skill
  for (const skill of online) {
    const name = skill.skillId.toLowerCase()
    if (!byName.has(name) && online.filter(other => other.skillId.toLowerCase() === name).length === 1) byId.set(name, skill)
  }
  const picked: string[] = []
  const pickedOnline: OnlineOption[] = []
  for (const entry of Array.isArray(data.skills) ? data.skills : []) {
    if (picked.length + pickedOnline.length === 3) break
    const key = text(entry).replace(/^[\s`/]+|[\s`]+$/g, '').toLowerCase()
    const name = byName.get(key)
    const found = byId.get(key)
    if (name !== undefined && !picked.includes(name)) picked.push(name)
    else if (name === undefined && found !== undefined && !pickedOnline.includes(found)) pickedOnline.push(found)
  }

  let rewrite = text(data.prompt).trim()
  if (rewrite === '') return undefined
  const missing = [
    ...picked.filter(name => !namesSkill(rewrite, name)).map(name => `Use the \`${name}\` skill.`),
    ...pickedOnline.filter(skill => !namesSkill(rewrite, skill.skillId)).map(skill => skill.line),
  ]
  if (missing.length > 0) rewrite = `${rewrite}\n\n${missing.join('\n')}`
  if (squash(rewrite) === squash(prompt) || keptShare(prompt, rewrite) < 0.4) return undefined

  return { prompt: rewrite, skills: picked, online: pickedOnline.map(skill => skill.id) }
}

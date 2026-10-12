import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import {
  ANALYZE_SYSTEM,
  DOCS_INDEX,
  PROMPT_LIBRARY,
  RESEARCH_SYSTEM,
  SKIP,
  TASK_DOCS,
  TASK_RESEARCH_SYSTEM,
  analysisRequest,
  asGuide,
  buildRequest,
  cleanGuide,
  fallbackDocs,
  index,
  isStale,
  libraryPrompts,
  namesSkill,
  parseAnalysis,
  parseModel,
  parseRewrite,
  pickDocs,
  rank,
  recentTurns,
  researchRequest,
  rewriteSystem,
  taskResearchRequest,
  webUrls,
  words,
  type Analysis,
  type Guide,
  type ModelInfo,
  type Skill,
} from './lib'
import {
  candidateLine,
  frontmatter,
  guessPaths,
  isAuditClean,
  isSkillFile,
  mergeHits,
  onlineSkillLine,
  pageText,
  pageUrl,
  parsePage,
  parseSearch,
  pathsFromTree,
  rawUrl,
  searchUrl,
  skillContext,
  treeUrl,
  type OnlineHit,
  type OnlineSkill,
} from './online'

const COMMAND = 'skill-coach'
const SEND_NEW = 'Send this prompt'
const EDIT = 'Edit it first'
const SEND_MINE = 'Send mine'

/** The model that reads what each prompt asks for: a quick label, so the fastest one. */
const ANALYZE_MODEL = 'haiku'
/** More installed skills than this, and only the ones that share words with the prompt are sent. */
const MAX_SKILLS_SENT = 60
/** How many online skills are checked for each prompt, and how many of those the rewrite is shown. */
const MAX_ONLINE_CHECKED = 6
const MAX_ONLINE_SHOWN = 4
/** After "Edit it first", the next prompt within this time is the edited one: it goes through unchecked. */
const EDIT_WINDOW_MS = 30 * 60 * 1000
/** A page that takes longer than this is left out. */
const FETCH_TIMEOUT_MS = 8000
/** After research failed, prompts go without it for this long before it is tried again. */
const RETRY_MS = 10 * 60 * 1000
/** How many kinds of task are remembered, so the analysis reuses their names. */
const MAX_KINDS = 40
const GITHUB_HEADERS = { 'User-Agent': 'skill-coach', Accept: 'application/vnd.github+json' }

/** What the rewrite needs to know about the session, read once per prompt. */
type Surroundings = { skills: Skill[]; conversation: string; project: string }

/** The prompt to offer and the online skills it names, whose SKILL.md goes with it. */
type Offer = { prompt: string; online: OnlineSkill[] }

/** The module's own state; a reload starts it over, as it does every module variable. */
const my = {
  model: 'sonnet',
  minChars: 15,
  isOn: true,
  listed: undefined as ReadonlySet<string> | undefined,
  guides: new Map<string, Guide>(),
  researching: new Set<string>(),
  failedAt: new Map<string, number>(),
  /** Online skills already checked this session: undefined when one did not pass. */
  online: new Map<string, OnlineSkill | undefined>(),
  passNextBefore: 0,
  /** The online skills of a prompt sent to the box to edit, attached when the edit still names them. */
  pending: [] as OnlineSkill[],
  warned: new Set<string>(),
  answeredBy: '',
}

export const register: Register = (on, options) => {
  my.model = typeof options.model === 'string' && options.model !== '' ? options.model : 'sonnet'
  my.minChars = typeof options.minChars === 'number' && options.minChars > 0 ? options.minChars : 15

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-coach',
      description: 'Skill coach: show its status and research, research again, or turn it on or off',
      argumentHint: '[guide [kind]|research|on|off]',
    })
    const stored = await $.store.get('enabled')
    if (typeof stored === 'boolean') my.isOn = stored
    const answered = await $.store.get('answeredBy')
    if (typeof answered === 'string') my.answeredBy = answered

    return next(e)
  })

  // the model id the API reports, for when /model shows only a label such as "Default"
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId === undefined ? e.usage?.model : undefined
    if (id !== undefined && id !== my.answeredBy && parseModel(id).family !== undefined) {
      my.answeredBy = id
      await $.store.set('answeredBy', id)
    }

    return next(e)
  })

  on('command.run', { command: 'skill-coach' }, async ($, e) => {
    const [arg = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/)
    if (arg === 'on' || arg === 'off') {
      my.isOn = arg === 'on'
      await $.store.set('enabled', my.isOn)
      return { text: `Skill coach is ${arg}.` }
    }

    const model = await sessionModel($)
    const modelKey = `model:${model.key}`
    const kinds = await knownKinds($)
    if (arg === 'research') {
      // the task research is redone as each kind of task comes up again
      await Promise.all(kinds.map(kind => $.store.delete(`guide:task:${kind}`)))
      await $.store.set('taskKinds', [])
      for (const key of [...my.guides.keys()]) if (key.startsWith('task:')) my.guides.delete(key)
      $.ui.status(`skill-coach: researching how to prompt ${model.display}…`)
      const guide = await researchModel($, model)
      $.ui.status(undefined)
      if (guide !== undefined) {
        my.guides.set(modelKey, guide)
        await $.store.set(`guide:${modelKey}`, guide)
      }
      return {
        text: guide === undefined
          ? `Skill coach could not research ${model.display}.`
          : `${guideText(guide)}\n\nThe research for each kind of task is redone the next time it comes up.`,
      }
    }
    if (arg === 'guide') {
      const kind = rest.join('-')
      const guide = await keptGuide($, kind === '' ? modelKey : `task:${kind}`)
      if (guide !== undefined) {
        return { text: `${guideText(guide)}${kind === '' && kinds.length > 0 ? `\n\nKinds of task researched: ${kinds.join(', ')}. Run /skill-coach guide <kind> to read one.` : ''}` }
      }
      return { text: kind === '' ? `${model.display} is not researched yet. Run /skill-coach research.` : `No research for "${kind}" yet.` }
    }

    const [guide, skills] = await Promise.all([keptGuide($, modelKey), installedSkills($)])
    return {
      text: [
        `Skill coach is ${my.isOn ? 'on' : 'off'}. For each prompt of ${my.minChars} characters or more it researches the model and the kind of task, finds the skills that fit, installed or online, and offers one rewritten prompt.`,
        `Model in this window: ${model.display}. ${guide === undefined ? 'Not researched yet: the next prompt researches it first.' : researchedLine(guide)}`,
        `Kinds of task researched: ${kinds.length === 0 ? 'none yet' : kinds.join(', ')}.`,
        `Skills: ${skills.length} installed, plus skills found on skills.sh with 1,000 installs or more whose security audits all passed.`,
        `Rewriting model: ${my.model}.`,
        'Commands: /skill-coach guide [kind], /skill-coach research, /skill-coach on, /skill-coach off.',
      ].join('\n'),
    }
  })

  on('prompt.submit', async ($, e, next) => {
    // typed at the terminal, in the desktop app (an SDK host), or from a phone through Remote Control
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge'
    if (!isPerson) return next(e)

    const text = e.text.trim()
    const isQuiet =
      !my.isOn ||
      e.turnId !== undefined ||
      (e.attachments?.length ?? 0) > 0 ||
      SKIP.test(text) ||
      text.length < my.minChars ||
      text.length > 6000
    if (isQuiet) return next(e)

    const now = await $.clock.now()
    if (now < my.passNextBefore) {
      // the prompt the person just edited from the suggestion (a short reply or a command in between does not count)
      my.passNextBefore = 0
      const kept = my.pending.filter(skill => namesSkill(e.text, skill.skillId))
      my.pending = []
      return next(withSkills(e, kept))
    }

    let offer: Offer | undefined
    try {
      offer = await prepare($, e.text)
    } catch (error) {
      warnOnce($, 'rewrite', `skill-coach could not rewrite this prompt (${String(error).slice(0, 200)}); it was sent as typed.`)
    } finally {
      $.ui.status(undefined)
    }
    if (offer === undefined) return next(e)

    // the prompt box can be filled only in the terminal; elsewhere "Other" is where to edit
    const surfaces: readonly string[] = await $.session.surfaces().catch(() => [])
    const canFill = surfaces.includes('terminal')
    let choice: string
    try {
      choice = await $.ui.ask(offer.prompt, { header: 'Prompt', options: canFill ? [SEND_NEW, EDIT, SEND_MINE] : [SEND_NEW, SEND_MINE] })
    } catch {
      return next(e) // dismissed, or no one to ask: send theirs untouched
    }

    if (choice === SEND_MINE) return next(e)
    if (choice === SEND_NEW) {
      // the chat keeps showing what was typed, so say what was sent instead
      $.ui.log(`skill-coach sent:\n${offer.prompt}${attachedNote(offer.online)}`)
      return next(withSkills({ ...e, text: offer.prompt }, offer.online))
    }
    if (choice === EDIT && canFill) {
      my.passNextBefore = (await $.clock.now()) + EDIT_WINDOW_MS
      my.pending = offer.online
      const draft = offer.prompt
      $.clock.after(150, () => void $.prompt.fill({ text: draft }))
      return { drop: 'Skill coach put the new prompt in the box. Edit it, then press Enter.' }
    }

    // free text typed under "Other": that is what they want to send, with the online skills it still names
    const kept = offer.online.filter(skill => namesSkill(choice, skill.skillId))
    $.ui.log(`skill-coach sent your own version:\n${choice}${attachedNote(kept)}`)
    return next(withSkills({ ...e, text: choice }, kept))
  })
}

/**
 * The whole preparation of one prompt: how to prompt the model in this
 * window, what the task is, how to prompt for that kind of task, which skills
 * fit (installed or online), and the rewrite that combines them.
 */
async function prepare($: EngineInterface, prompt: string): Promise<Offer | undefined> {
  const [model, around] = await Promise.all([sessionModel($), surroundings($, prompt)])
  $.ui.status(`skill-coach: researching ${model.display} and your task, and looking for skills online…`)
  // the model's research does not wait for the task's: both run at once
  const [guide, { analysis, taskGuide, online }] = await Promise.all([
    guideFor($, `model:${model.key}`, () => researchModel($, model)),
    (async () => {
      const analysis = await analyze($, prompt, around)
      const [taskGuide, online] = await Promise.all([
        guideFor($, `task:${analysis.kind}`, () => researchTask($, analysis)),
        findOnline($, analysis, around.skills),
      ])
      return { analysis, taskGuide, online }
    })(),
  ])
  const label = analysis.kind.replace(/-/g, ' ')

  $.ui.status(`skill-coach: writing your prompt for ${model.display}…`)
  const result = await $.model.complete({
    model: my.model,
    system: rewriteSystem(model.display),
    prompt: buildRequest({
      model: model.display,
      guide: guide?.text ?? `(not researched: use what you know about prompting ${model.display})`,
      kind: analysis.kind,
      taskGuide: taskGuide?.text ?? `(not researched: use what you know about prompting for ${label})`,
      prompt,
      project: around.project,
      conversation: around.conversation,
      skills: around.skills,
      online: online.map(skill => ({ about: candidateLine(skill), line: onlineSkillLine(skill) })),
    }),
    maxTokens: 4000,
    effort: 'low',
    timeoutMs: 60_000,
  })
  if (!result.isAnswered) {
    warnOnce($, 'rewrite', `skill-coach could not reach ${my.model} (${result.reason}); prompts are sent as typed.`)
    return undefined
  }
  const options = online.map(skill => ({ id: skill.id, skillId: skill.skillId, source: skill.source, line: onlineSkillLine(skill) }))
  const rewrite = parseRewrite(result.text, prompt, around.skills, options)
  if (rewrite === undefined) return undefined

  return { prompt: rewrite.prompt, online: online.filter(skill => rewrite.online.includes(skill.id)) }
}

/** The prompt with each online skill's SKILL.md beside it, for the model alone. */
function withSkills<E extends { context?: readonly string[] }>(e: E, skills: readonly OnlineSkill[]): E {
  return skills.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...skills.map(skillContext)] }
}

function attachedNote(skills: readonly OnlineSkill[]): string {
  return skills.length === 0
    ? ''
    : `\n\n(with the SKILL.md of ${skills.map(skill => `${skill.skillId} from github.com/${skill.source}`).join(' and ')})`
}

/** The model the session runs right now, so a /model switch is followed. */
async function sessionModel($: EngineInterface): Promise<ModelInfo> {
  const shown = parseModel(await $.session.model().catch(() => ''))
  return shown.family === undefined && my.answeredBy !== '' ? parseModel(my.answeredBy) : shown
}

/** A guide kept from this session or an earlier one. */
async function keptGuide($: EngineInterface, key: string): Promise<Guide | undefined> {
  const held = my.guides.get(key)
  if (held !== undefined) return held
  const stored = asGuide(await $.store.get(`guide:${key}`).catch(() => undefined))
  if (stored !== undefined) my.guides.set(key, stored)

  return stored
}

/** A guide: the kept one while fresh, else researched now, before the prompt is rewritten. */
async function guideFor($: EngineInterface, key: string, research: () => Promise<Guide | undefined>): Promise<Guide | undefined> {
  const kept = await keptGuide($, key)
  const now = await $.clock.now()
  if (kept !== undefined && !isStale(kept, now)) return kept
  if (my.researching.has(key)) return kept // another prompt is researching it right now
  if (now - (my.failedAt.get(key) ?? -Infinity) < RETRY_MS) return kept

  my.researching.add(key)
  try {
    const found = await research()
    if (found === undefined) {
      my.failedAt.set(key, await $.clock.now())
      return kept
    }
    my.guides.set(key, found)
    await $.store.set(`guide:${key}`, found)
    return found
  } finally {
    my.researching.delete(key)
  }
}

/** Reads Anthropic's docs about prompting the model and distills them into a short guide. */
async function researchModel($: EngineInterface, model: ModelInfo): Promise<Guide | undefined> {
  const docsIndex = await fetchText($, DOCS_INDEX)
  const picked = docsIndex === '' ? [] : pickDocs(docsIndex, model)
  const urls = picked.length > 0 ? picked : fallbackDocs(model)
  const pages = await Promise.all(urls.map(async url => ({ url, text: await fetchText($, url) })))
  const docs = pages.filter(page => page.text.trim() !== '')

  const result = await $.model.complete({
    model: my.model,
    system: RESEARCH_SYSTEM,
    prompt: researchRequest(model, docs),
    maxTokens: 2000,
    effort: 'medium',
    timeoutMs: 120_000,
  })
  if (!result.isAnswered) {
    warnOnce($, 'research', `skill-coach could not research ${model.display} (${result.reason}); it used general prompting advice.`)
    return undefined
  }
  const text = cleanGuide(result.text)

  return text === ''
    ? undefined
    : { key: `model:${model.key}`, title: model.display, text, sources: docs.map(doc => doc.url), at: await $.clock.now(), from: docs.length > 0 ? 'docs' : 'knowledge' }
}

/**
 * Researches how to prompt for one kind of task: the Claude Code docs (best
 * practices, common workflows, the prompt library) and a web search, distilled
 * into a short guide.
 */
async function researchTask($: EngineInterface, analysis: Analysis): Promise<Guide | undefined> {
  const label = analysis.kind.replace(/-/g, ' ')
  const [pages, web] = await Promise.all([
    Promise.all(TASK_DOCS.map(async url => {
      const page = await fetchText($, url)
      // the prompt library's page is a component: its example prompts are the part worth reading
      return { url, text: url === PROMPT_LIBRARY ? libraryPrompts(page) || page : page }
    })),
    webSearch($, analysis.question),
  ])
  const docs = pages.filter(page => page.text.trim() !== '')

  const result = await $.model.complete({
    model: my.model,
    system: TASK_RESEARCH_SYSTEM,
    prompt: taskResearchRequest({ analysis, docs, web }),
    maxTokens: 1500,
    effort: 'medium',
    timeoutMs: 120_000,
  })
  if (!result.isAnswered) {
    warnOnce($, 'research-task', `skill-coach could not research prompting for ${label} (${result.reason}).`)
    return undefined
  }
  const text = cleanGuide(result.text)
  if (text === '') return undefined
  const kinds = await knownKinds($)
  if (!kinds.includes(analysis.kind)) await $.store.set('taskKinds', [analysis.kind, ...kinds].slice(0, MAX_KINDS))

  return {
    key: `task:${analysis.kind}`,
    title: label,
    text,
    sources: [...docs.map(doc => doc.url), ...webUrls(web)],
    at: await $.clock.now(),
    from: docs.length > 0 || web !== '' ? 'docs' : 'knowledge',
  }
}

/** The kinds of task researched so far, newest first. */
async function knownKinds($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get('taskKinds').catch(() => undefined)
  return Array.isArray(stored) ? stored.filter((kind): kind is string => typeof kind === 'string') : []
}

/** One web search through the session's own WebSearch tool, where it is allowed; '' otherwise. */
async function webSearch($: EngineInterface, query: string): Promise<string> {
  try {
    const verdict = await $.tool.check({ tool: 'WebSearch', input: { query, mode: 'standard' } })
    if (verdict.decision === 'deny') return ''
    const result = await $.tool.call({ tool: 'WebSearch', query, mode: 'standard' })
    return result.isError === true || result.deny !== undefined ? '' : result.text ?? ''
  } catch {
    return '' // no such tool here, or the call was refused
  }
}

/** What the analysis and the rewrite read about the session: the installed skills, the last turns, the project. */
async function surroundings($: EngineInterface, prompt: string): Promise<Surroundings> {
  const [all, messages, root] = await Promise.all([
    installedSkills($),
    $.session.messages().catch(() => []),
    $.session.root().catch(() => ''),
  ])
  const skills = all.length <= MAX_SKILLS_SENT
    ? all
    : rank(words(prompt), index(all), 40).map(({ name, description }) => ({ name, description }))

  return {
    skills,
    conversation: Array.isArray(messages) ? recentTurns(messages) : '',
    project: root.split(/[\\/]/).filter(part => part !== '').at(-1) ?? '',
  }
}

/** What the prompt asks for: the task, its kind, and what to search for. */
async function analyze($: EngineInterface, prompt: string, around: Surroundings): Promise<Analysis> {
  const result = await $.model.complete({
    model: ANALYZE_MODEL,
    system: ANALYZE_SYSTEM,
    prompt: analysisRequest({ prompt, project: around.project, conversation: around.conversation, kinds: await knownKinds($) }),
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 30_000,
  })

  return parseAnalysis(result.isAnswered ? result.text : '', prompt)
}

/** Reliable skills on skills.sh for this task that are not installed, each with its SKILL.md. */
async function findOnline($: EngineInterface, analysis: Analysis, installed: readonly Skill[]): Promise<OnlineSkill[]> {
  if (analysis.searches.length === 0) return []
  const answers = await Promise.all(analysis.searches.map(query => fetchText($, searchUrl(query))))
  // an installed plugin skill is named `plugin:skill`
  const names = new Set(installed.map(skill => (skill.name.split(':').at(-1) ?? skill.name).toLowerCase()))
  const hits = mergeHits(answers.map(parseSearch), names, MAX_ONLINE_CHECKED)
  const checked = await Promise.all(hits.map(hit => vet($, hit)))

  return checked.filter((skill): skill is OnlineSkill => skill !== undefined).slice(0, MAX_ONLINE_SHOWN)
}

/** An online skill that passed: every security audit clean and its SKILL.md found; undefined otherwise. */
async function vet($: EngineInterface, hit: OnlineHit): Promise<OnlineSkill | undefined> {
  if (my.online.has(hit.id)) return my.online.get(hit.id)
  const [html, file] = await Promise.all([fetchText($, pageUrl(hit)), skillFile($, hit)])
  const page = parsePage(pageText(html))
  const skill = isAuditClean(page.audits) && file !== undefined
    ? {
        ...hit,
        description: frontmatter(file.body).description || page.summary,
        stars: page.stars,
        audits: page.audits,
        path: file.path,
        body: file.body,
      }
    : undefined
  my.online.set(hit.id, skill)

  return skill
}

/** The skill's SKILL.md in its GitHub repository: where such files usually sit, else found in the tree. */
async function skillFile($: EngineInterface, hit: OnlineHit): Promise<{ path: string; body: string } | undefined> {
  const read = (paths: readonly string[]) =>
    Promise.all(paths.map(async path => ({ path, body: await fetchText($, rawUrl(hit.source, path)) })))
  const isIt = (file: { path: string; body: string }) => isSkillFile(file.body, file.path, hit.skillId)

  const guessed = (await read(guessPaths(hit.skillId))).find(isIt)
  if (guessed !== undefined) return guessed
  const tree = await fetchText($, treeUrl(hit.source), GITHUB_HEADERS)

  return tree === '' ? undefined : (await read(pathsFromTree(tree, hit.skillId))).find(isIt)
}

/** A page's text, or '' when it fails or takes too long. */
async function fetchText($: EngineInterface, url: string, headers?: Record<string, string>): Promise<string> {
  const stop = new AbortController()
  try {
    const response = await Promise.race([
      $.http.fetch(url, headers === undefined ? undefined : { headers }),
      $.clock.sleep(FETCH_TIMEOUT_MS, { signal: stop.signal }).then(() => undefined, () => undefined),
    ])
    return response?.ok === true ? response.text : ''
  } catch {
    return ''
  } finally {
    stop.abort()
  }
}

/** The names the context lists as skills, read once a session. */
async function skillListing($: EngineInterface): Promise<ReadonlySet<string>> {
  if (my.listed !== undefined) return my.listed
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    my.listed = new Set((usage.context.breakdown?.skills?.skillFrontmatter ?? []).map(skill => skill.name.toLowerCase()))
  } catch {
    my.listed = new Set()
  }

  return my.listed
}

/** Every installed skill and command the prompt could use. */
async function installedSkills($: EngineInterface): Promise<Skill[]> {
  const [commands, names] = await Promise.all([
    $.command.list().catch((): CommandInfo[] => []),
    skillListing($),
  ])

  return commands
    .filter(command =>
      command.name !== COMMAND &&
      (command.source === 'plugin' || command.source === 'user' || names.has(command.name.toLowerCase())))
    .map(command => ({ name: command.name, description: command.description }))
}

/** Says once a session why the coach stepped aside, so a failure is never silent. */
function warnOnce($: EngineInterface, kind: string, line: string): void {
  if (my.warned.has(kind)) return
  my.warned.add(kind)
  $.ui.log(line)
}

function researchedLine(guide: Guide): string {
  const day = new Date(guide.at).toISOString().slice(0, 10)
  const count = guide.sources.length
  return guide.from === 'docs'
    ? `Researched ${day} from ${count} ${count === 1 ? 'source' : 'sources'}.`
    : `Written ${day} from the model's own knowledge (no source could be read).`
}

function guideText(guide: Guide): string {
  const sources = guide.sources.length > 0 ? `\n\nSources:\n${guide.sources.map(url => `- ${url}`).join('\n')}` : ''
  return `How to prompt ${guide.key.startsWith('task:') ? `for ${guide.title}` : guide.title} (${researchedLine(guide)})\n\n${guide.text}${sources}`
}

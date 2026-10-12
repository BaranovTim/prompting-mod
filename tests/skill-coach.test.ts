import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  ANALYZE_SYSTEM,
  DOCS_INDEX,
  PROMPT_LIBRARY,
  RESEARCH_SYSTEM,
  TASK_DOCS,
  TASK_RESEARCH_SYSTEM,
  libraryPrompts,
  parseAnalysis,
  parseModel,
  parseRewrite,
  pickDocs,
} from '../hooks/lib'
import {
  frontmatter,
  isAuditClean,
  mergeHits,
  pageText,
  parsePage,
  parseSearch,
  pathsFromTree,
  rawUrl,
  searchUrl,
  treeUrl,
} from '../hooks/online'

const COMMANDS = [
  { name: 'xlsx', description: 'Create and edit Excel spreadsheets with formulas and charts', source: 'plugin', plugin: 'office' },
  { name: 'deploy-notes', description: 'Write release notes for a deploy', source: 'user' },
  { name: 'compact', description: 'Clear the conversation but keep a summary', source: 'builtin' },
  { name: 'skill-coach', description: 'Skill coach status', source: 'plugin', plugin: 'skill-coach' },
]

// Anthropic's docs
const BASE = 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering'
const OWN_PAGE = `${BASE}/prompting-claude-opus-5-5.md`
const GENERAL_PAGE = `${BASE}/claude-prompting-best-practices.md`
const LLMS = [
  '### Best practices',
  `- [Prompting best practices](${GENERAL_PAGE})`,
  `- [Prompting Claude Opus 5](${BASE}/prompting-claude-opus-5.md)`,
  `- [Prompting Claude Opus 5.5](${OWN_PAGE})`,
  `- [Prompting Claude Sonnet 5.5](${BASE}/prompting-claude-sonnet-5-5.md)`,
].join('\n')
const LIBRARY_PAGE = "const RAW = [{\n  cat: 'Prototype',\n  prompt: 'implement this design, then take a screenshot and compare it to the original'\n}]"

// skills.sh and GitHub
const SKILL_MD = '---\nname: frontend-design\ndescription: Distinctive, intentional visual design for new UI.\n---\n\n# Frontend Design\nPick a bold direction.'
const TDD_MD = '---\nname: tdd\ndescription: Test-driven development, red-green-refactor.\n---\n\n# TDD'
const page = (summary: string, audits: string) =>
  `<html><body><h1>skill</h1><div>Summary</div><p>${summary}</p><div><span>SKILL.md</span></div>` +
  `<div>Installs 975.9K</div><div>GitHub Stars 180.5K</div><div>Security Audits</div>${audits}<div>Browse</div></body></html>`
const CLEAN = '<div>Gen Agent Trust Hub</div><div>Pass</div><div>Socket</div><div>Pass</div><div>Snyk</div><div>Pass</div>'
const SEARCH = JSON.stringify({
  skills: [
    { id: 'anthropics/skills/frontend-design', source: 'anthropics/skills', skillId: 'frontend-design', name: 'frontend-design', installs: 975_496 },
    { id: 'nobody/tiny/frontend-x', source: 'nobody/tiny', skillId: 'frontend-x', name: 'frontend-x', installs: 12 },
    { id: 'risky/repo/frontend-risky', source: 'risky/repo', skillId: 'frontend-risky', name: 'frontend-risky', installs: 5000 },
    { id: 'smithery.ai/frontend-design', source: 'smithery.ai', skillId: 'frontend-design', name: 'frontend-design', installs: 6319 },
    { id: 'anthropics/skills/xlsx', source: 'anthropics/skills', skillId: 'xlsx', name: 'xlsx', installs: 300_000 },
    { id: 'mattpocock/skills/tdd', source: 'mattpocock/skills', skillId: 'tdd', name: 'tdd', installs: 50_000 },
  ],
})
const TREE = JSON.stringify({ tree: [{ path: 'README.md' }, { path: 'skills/engineering/tdd/SKILL.md' }, { path: 'skills/writing/notes/SKILL.md' }] })

const PAGES: Record<string, string> = {
  [DOCS_INDEX]: LLMS,
  [OWN_PAGE]: 'Opus 5.5 works best when the prompt says what done looks like.',
  [GENERAL_PAGE]: 'Be clear and direct. Give context and the reason behind the ask.',
  [TASK_DOCS[0] ?? '']: 'Give Claude a way to verify its work, such as screenshots for UI.',
  [TASK_DOCS[1] ?? '']: 'For UI work, paste a mockup and ask for a screenshot comparison.',
  [PROMPT_LIBRARY]: LIBRARY_PAGE,
  [searchUrl('frontend design')]: SEARCH,
  'https://skills.sh/anthropics/skills/frontend-design': page('Distinctive frontend interfaces.', CLEAN),
  'https://skills.sh/risky/repo/frontend-risky': page('Risky.', '<div>Gen Agent Trust Hub</div><div>Warn</div><div>Socket</div><div>Pass</div><div>Snyk</div><div>Pass</div>'),
  'https://skills.sh/mattpocock/skills/tdd': page('Test-driven development.', CLEAN),
  [rawUrl('anthropics/skills', 'skills/frontend-design/SKILL.md')]: SKILL_MD,
  [rawUrl('risky/repo', 'skills/frontend-risky/SKILL.md')]: '---\nname: frontend-risky\n---\n',
  [treeUrl('mattpocock/skills')]: TREE,
  [rawUrl('mattpocock/skills', 'skills/engineering/tdd/SKILL.md')]: TDD_MD,
}

const MODEL_GUIDE = '- State the goal first.\n- Say what done looks like and how to check it.'
const TASK_GUIDE = '- Ask for a screenshot of the result and a comparison with the design.\nExample: build the page, then screenshot it'
const WEB = 'Web search results for "prompting Claude Code for frontend design": https://example.com/frontend-prompting. Describe the visual direction.'
const ANALYSIS = JSON.stringify({
  task: 'build a landing page for a bakery in React',
  kind: 'Frontend Design',
  searches: ['frontend design'],
  question: 'how to prompt Claude Code for frontend design',
})
const PROMPT = 'build a landing page for my bakery in react with a menu and opening hours'
const SKILL_LINE = 'Use the `frontend-design` skill from anthropics/skills (attached below).'
const REWRITE =
  'Build a landing page for my bakery in React, with a menu section and the opening hours. ' +
  'Done when it renders without console errors and works on a phone; take a screenshot to check.\n' +
  `${SKILL_LINE}`
const REPLY = JSON.stringify({ skills: ['anthropics/skills/frontend-design', 'made-up'], prompt: REWRITE })
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 100 }
const START = { cwd: '/work/bakery', surface: 'terminal', isInteractive: true } as const

type Setup = {
  model?: string
  reply?: string
  answer?: string
  surfaces?: string[]
  isOffline?: boolean
  isModelDown?: boolean
  isSearchDenied?: boolean
}

type World = {
  research: string[]
  taskResearch: string[]
  analyses: string[]
  rewrites: string[]
  fetched: Array<{ url: string; headers?: Record<string, string> }>
  searches: string[]
  questions: string[]
  options: string[][]
  sent: Array<{ text: string; context: readonly string[] }>
  filled: string[]
  logs: string[]
}

/** The engine and the web beneath the plugin: every call it makes, answered from memory and recorded. */
function world(on: On, setup: Setup = {}): World & { clock: ReturnType<typeof mock.clock> } {
  const seen: World = {
    research: [], taskResearch: [], analyses: [], rewrites: [], fetched: [], searches: [],
    questions: [], options: [], sent: [], filled: [], logs: [],
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: COMMANDS }) as never)
  on('session.usage', () => ({
    value: {
      context: {
        window: 200_000,
        breakdown: { skills: { totalSkills: 1, includedSkills: 1, tokens: 10, skillFrontmatter: [{ name: 'xlsx', source: 'plugin', tokens: 10 }] } },
      },
    },
  }) as never)
  on('session.messages', () => ({ value: [] }))
  on('session.root', () => ({ value: '/work/bakery' }))
  on('session.model', () => ({ value: setup.model ?? 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: (setup.surfaces ?? ['terminal']) as never }))
  on('http.fetch', ($, e) => {
    seen.fetched.push({ url: e.url, headers: e.init?.headers })
    if (setup.isOffline === true) throw new Error('getaddrinfo ENOTFOUND')
    const body = PAGES[e.url]
    return { value: { status: body === undefined ? 404 : 200, ok: body !== undefined, headers: {}, text: body ?? '' } }
  })
  on('model.complete', ($, e) => {
    if (setup.isModelDown === true) {
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } } as never
    }
    const [list, text] =
      e.system === RESEARCH_SYSTEM ? [seen.research, MODEL_GUIDE]
        : e.system === TASK_RESEARCH_SYSTEM ? [seen.taskResearch, TASK_GUIDE]
          : e.system === ANALYZE_SYSTEM ? [seen.analyses, ANALYSIS]
            : [seen.rewrites, setup.reply ?? REPLY]
    list.push(e.prompt)
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('tool.check', () => ({ decision: setup.isSearchDenied === true ? 'deny' : 'allow' }) as never)
  on('tool.call', { tool: 'WebSearch' }, ($, e) => {
    seen.searches.push(e.query)
    return { result: { query: e.query, results: [], durationSeconds: 1 }, text: WEB } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const asked = e.questions[0]
    const question = asked?.question ?? ''
    seen.questions.push(question)
    seen.options.push((asked?.options ?? []).map(option => option.label))
    return { result: { questions: e.questions, answers: { [question]: setup.answer ?? 'Send this prompt' } } } as never
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', ($, e) => {
    seen.sent.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text }
  })

  return { ...seen, clock }
}

describe('before a prompt is sent', () => {
  test('researches the model and the task, finds a reliable skill online, and offers one prompt', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    // the model, from its own docs page
    expect(w.research[0]).toContain('Claude Opus 5.5')
    expect(w.research[0]).toContain('what done looks like')
    // the task, read from the prompt, then researched from the Claude Code docs and the web
    expect(w.analyses[0]).toContain(PROMPT)
    expect(w.searches).toEqual(['how to prompt Claude Code for frontend design'])
    const taskResearch = w.taskResearch[0] ?? ''
    expect(taskResearch).toContain('The kind of task: frontend design.')
    expect(taskResearch).toContain('screenshots for UI')
    expect(taskResearch).toContain('[Prototype] implement this design')
    expect(taskResearch).toContain('example.com/frontend-prompting')
    // one rewrite that reads both guides and every skill, installed and online
    const request = w.rewrites[0] ?? ''
    expect(request).toContain(`How to prompt Claude Opus 5.5:\n${MODEL_GUIDE}`)
    expect(request).toContain(`How to prompt for frontend design:\n${TASK_GUIDE}`)
    expect(request).toContain('`xlsx`')
    expect(request).toContain('`anthropics/skills/frontend-design`')
    expect(request).toContain('Gen Agent Trust Hub Pass, Socket Pass, Snyk Pass')
    expect(request).toContain(`Line to add: ${SKILL_LINE}`)
    // too few installs, an audit that warned, no GitHub source, already installed: left out
    expect(request).not.toContain('frontend-x')
    expect(request).not.toContain('frontend-risky')
    expect(request).not.toContain('smithery')
    expect(request).not.toContain('anthropics/skills/xlsx')
    // the dialog shows the prompt alone; the skill's SKILL.md goes with it, for the agent
    expect(w.questions).toEqual([REWRITE])
    expect(w.sent.map(sent => sent.text)).toEqual([REWRITE])
    const context = w.sent[0]?.context ?? []
    expect(context.length).toBe(1)
    expect(context[0]).toContain(SKILL_MD)
    expect(context[0]).toContain('https://github.com/anthropics/skills/blob/HEAD/skills/frontend-design/SKILL.md')
  })

  test('the research is kept: a later prompt of the same kind is not researched again', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })
    await $.prompt.submit({ text: `${PROMPT} and a contact form`, origin: COMPOSER, wait: false })

    expect(w.research.length).toBe(1)
    expect(w.taskResearch.length).toBe(1)
    expect(w.searches.length).toBe(1)
    expect(w.rewrites.length).toBe(2)
    expect(w.analyses[1]).toContain('Known kinds: frontend-design')
    // the online skill was checked once
    expect(w.fetched.filter(f => f.url === 'https://skills.sh/anthropics/skills/frontend-design').length).toBe(1)
  })

  test('finds a SKILL.md through the repository tree when it is not where skills usually sit', async ($, on) => {
    const reply = JSON.stringify({ skills: ['mattpocock/skills/tdd'], prompt: `${PROMPT}. Write the tests first.` })
    const w = world(on, { reply })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    const tree = w.fetched.find(f => f.url === treeUrl('mattpocock/skills'))
    expect(tree?.headers?.['User-Agent']).toBe('skill-coach')
    // picked but not named, so its line is added
    expect(w.questions).toEqual([`${PROMPT}. Write the tests first.\n\nUse the \`tdd\` skill from mattpocock/skills (attached below).`])
    expect(w.sent[0]?.context[0]).toContain(TDD_MD)
    expect(w.sent[0]?.context[0]).toContain('skills/engineering/tdd/SKILL.md')
  })

  test('where web search is not allowed, the task is researched from the docs alone', async ($, on) => {
    const w = world(on, { isSearchDenied: true })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.searches).toEqual([])
    expect(w.taskResearch[0]).toContain('No web search was available.')
    expect(w.taskResearch[0]).toContain('screenshots for UI')
    expect(w.sent.map(sent => sent.text)).toEqual([REWRITE])
  })

  test('offline, it still writes both guides from what the model knows, with no online skills', async ($, on) => {
    const w = world(on, { isOffline: true, reply: JSON.stringify({ skills: [], prompt: `${PROMPT}. Done when it works on a phone.` }) })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.research[0]).toContain('could not be fetched')
    expect(w.taskResearch[0]).toContain('The documentation could not be fetched.')
    expect(w.rewrites[0]).toContain('Reliable skills found online, not installed:\n(none found)')
    expect(w.sent.map(sent => sent.text)).toEqual([`${PROMPT}. Done when it works on a phone.`])
    expect(w.sent[0]?.context).toEqual([])
  })

  test('the terminal offers "Edit it first": the edit goes through with the skill it still names', async ($, on) => {
    const w = world(on, { answer: 'Edit it first' })
    await $.session.start(START)

    const result = await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.options[0]).toEqual(['Send this prompt', 'Edit it first', 'Send mine'])
    expect(result.drop).toContain('Edit it')
    await w.clock.advance(200)
    expect(w.filled).toEqual([REWRITE])

    await $.prompt.submit({ text: `${REWRITE}\nUse warm colors.`, origin: COMPOSER, wait: false })
    expect(w.rewrites.length).toBe(1)
    expect(w.sent.map(sent => sent.text)).toEqual([`${REWRITE}\nUse warm colors.`])
    expect(w.sent[0]?.context[0]).toContain(SKILL_MD)
  })

  test('the desktop app has no prompt box to fill, so it offers send or keep', async ($, on) => {
    const w = world(on, { surfaces: ['desktop'] })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: { kind: 'sdk' }, wait: false })

    expect(w.options[0]).toEqual(['Send this prompt', 'Send mine'])
    expect(w.sent.map(sent => sent.text)).toEqual([REWRITE])
  })

  test('"Send mine" sends what was typed, with nothing attached', async ($, on) => {
    const w = world(on, { answer: 'Send mine' })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.sent).toEqual([{ text: PROMPT, context: [] }])
  })

  test('a prompt that is already right goes through without a question', async ($, on) => {
    const w = world(on, { reply: JSON.stringify({ skills: [], prompt: PROMPT }) })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.questions).toEqual([])
    expect(w.sent.map(sent => sent.text)).toEqual([PROMPT])
  })

  test('when the model cannot be reached the prompt goes as typed, and it says why once', async ($, on) => {
    const w = world(on, { isModelDown: true })
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })
    await $.prompt.submit({ text: `${PROMPT} again`, origin: COMPOSER, wait: false })

    expect(w.sent.map(sent => sent.text)).toEqual([PROMPT, `${PROMPT} again`])
    expect(w.logs.filter(line => line.includes(`could not research Claude Opus 5.5`)).length).toBe(1)
    expect(w.logs.filter(line => line.includes('could not reach')).length).toBe(1)
  })

  test('when /model shows only "Default", it writes for the model that answered', async ($, on) => {
    const w = world(on, { model: 'Default (recommended)' })
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await $.session.start(START)

    await $.turn.complete({
      answer: 'hi',
      durationMs: 1,
      isAborted: false,
      turnId: 't1',
      reason: 'answer',
      usage: { ...USAGE, model: 'claude-opus-5-5' },
    })
    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.research[0]).toContain('Claude Opus 5.5')
    expect(w.fetched.some(f => f.url === OWN_PAGE)).toBe(true)
  })

  test('a short reply and a command go through without a check', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    await $.prompt.submit({ text: 'yes', origin: COMPOSER, wait: false })
    await $.prompt.submit({ text: '/compact keep the plan', origin: COMPOSER, wait: false })

    expect(w.analyses.length + w.rewrites.length).toBe(0)
    expect(w.sent.map(sent => sent.text)).toEqual(['yes', '/compact keep the plan'])
  })

  test('/skill-coach off stops the checks', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    const off = await $.command.run({ command: 'skill-coach', args: 'off', origin: COMPOSER, presentation: PRESENTATION })
    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(off.text).toBe('Skill coach is off.')
    expect(w.rewrites.length).toBe(0)
    expect(w.sent.map(sent => sent.text)).toEqual([PROMPT])
  })
})

describe('/skill-coach', () => {
  test('says what it researched, and shows each guide', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    const before = await $.command.run({ command: 'skill-coach', args: '', origin: COMPOSER, presentation: PRESENTATION })
    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })
    const after = await $.command.run({ command: 'skill-coach', args: '', origin: COMPOSER, presentation: PRESENTATION })
    const modelGuide = await $.command.run({ command: 'skill-coach', args: 'guide', origin: COMPOSER, presentation: PRESENTATION })
    const taskGuide = await $.command.run({ command: 'skill-coach', args: 'guide frontend design', origin: COMPOSER, presentation: PRESENTATION })

    expect(before.text).toContain('Model in this window: Claude Opus 5.5. Not researched yet')
    expect(before.text).toContain('Skills: 2 installed')
    expect(after.text).toContain('Kinds of task researched: frontend-design.')
    expect(modelGuide.text).toContain(MODEL_GUIDE)
    expect(modelGuide.text).toContain(OWN_PAGE)
    expect(taskGuide.text).toContain('How to prompt for frontend design')
    expect(taskGuide.text).toContain(TASK_GUIDE)
    expect(taskGuide.text).toContain('https://example.com/frontend-prompting')
    expect(w.research.length).toBe(1)
  })

  test('/skill-coach research redoes the model and forgets the task research', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })
    const redone = await $.command.run({ command: 'skill-coach', args: 'research', origin: COMPOSER, presentation: PRESENTATION })
    await $.prompt.submit({ text: `${PROMPT} today`, origin: COMPOSER, wait: false })

    expect(redone.text).toContain(MODEL_GUIDE)
    expect(w.research.length).toBe(2)
    expect(w.taskResearch.length).toBe(2)
  })
})

describe('helpers', () => {
  test('reads the model however /model spells it', () => {
    expect(parseModel('claude-opus-5-5').display).toBe('Claude Opus 5.5')
    expect(parseModel('claude-opus-5-5[1m]').key).toBe('opus-5-5')
    expect(parseModel('Opus 5.5').key).toBe('opus-5-5')
    expect(parseModel('claude-sonnet-4-5-20250929').key).toBe('sonnet-4-5')
    expect(parseModel('claude-opus-4-20250514').key).toBe('opus-4')
    expect(parseModel('claude-3-5-sonnet-20241022').display).toBe('Claude Sonnet 3.5')
    expect(parseModel('sonnet')).toMatchObject({ key: 'sonnet', family: 'sonnet', version: undefined })
    expect(parseModel('').display).toBe('the session model')
  })

  test("picks the model's own docs page, the nearest earlier one, or the newest for a bare alias", () => {
    expect(pickDocs(LLMS, parseModel('claude-opus-5-5'))).toEqual([OWN_PAGE, GENERAL_PAGE])
    expect(pickDocs(LLMS, parseModel('claude-opus-5-2'))).toEqual([`${BASE}/prompting-claude-opus-5.md`, GENERAL_PAGE])
    expect(pickDocs(LLMS, parseModel('opus'))).toEqual([OWN_PAGE, GENERAL_PAGE])
    expect(pickDocs(LLMS, parseModel('claude-haiku-5-5'))).toEqual([GENERAL_PAGE])
    expect(pickDocs(LLMS, parseModel('Default (recommended)'))).toEqual([GENERAL_PAGE])
  })

  test('reads the analysis, and falls back to the prompt when there is none', () => {
    expect(parseAnalysis(ANALYSIS, PROMPT)).toMatchObject({ kind: 'frontend-design', searches: ['frontend design'] })
    const fallback = parseAnalysis('not json', PROMPT)
    expect(fallback.kind).toBe('general')
    expect(fallback.searches).toEqual(['build landing page bakery'])
    expect(libraryPrompts(LIBRARY_PAGE)).toBe('[Prototype] implement this design, then take a screenshot and compare it to the original')
  })

  test('a rewrite that replaces or answers the prompt is not offered', () => {
    const skills = [{ name: 'xlsx', description: 'Excel' }]
    const replaced = JSON.stringify({ skills: ['xlsx'], prompt: 'Write a poem about the ocean waves at night.' })
    expect(parseRewrite(replaced, PROMPT, skills)).toBeUndefined()
    expect(parseRewrite('not json', PROMPT, skills)).toBeUndefined()
    const option = { id: 'anthropics/skills/frontend-design', skillId: 'frontend-design', source: 'anthropics/skills', line: SKILL_LINE }
    expect(parseRewrite(REPLY, PROMPT, skills, [option])).toEqual({ prompt: REWRITE, skills: [], online: [option.id] })
    // a bare name of an offered online skill is taken too
    const bare = JSON.stringify({ skills: ['frontend-design'], prompt: `${PROMPT}, warm colors` })
    expect(parseRewrite(bare, PROMPT, skills, [option])?.online).toEqual([option.id])
  })

  test('reads skills.sh: trusted GitHub hits, page audits, SKILL.md paths and frontmatter', () => {
    const hits = parseSearch(SEARCH)
    expect(hits.map(hit => hit.id)).not.toContain('smithery.ai/frontend-design')
    expect(mergeHits([hits], new Set(['xlsx']), 5).map(hit => hit.id))
      .toEqual(['anthropics/skills/frontend-design', 'risky/repo/frontend-risky', 'mattpocock/skills/tdd'])
    const clean = parsePage(pageText(page('Distinctive frontend interfaces.', CLEAN)))
    expect(clean).toEqual({ stars: 180_500, audits: 'Gen Agent Trust Hub Pass, Socket Pass, Snyk Pass', summary: 'Distinctive frontend interfaces.' })
    expect(isAuditClean(clean.audits)).toBe(true)
    expect(isAuditClean('Gen Agent Trust Hub Pass, Socket Warn, Snyk Pass')).toBe(false)
    expect(isAuditClean('Gen Agent Trust Hub Safe, Socket 0 alerts, Snyk Low Risk')).toBe(true)
    expect(isAuditClean('Gen Agent Trust Hub Safe, Socket 0 alerts, Snyk Med Risk')).toBe(false)
    expect(isAuditClean('')).toBe(false)
    expect(pathsFromTree(TREE, 'tdd')).toEqual(['skills/engineering/tdd/SKILL.md'])
    expect(frontmatter('---\nname: a\ndescription: >\n  folded\n  text\n---\n')).toEqual({ name: 'a', description: 'folded text' })
  })
})

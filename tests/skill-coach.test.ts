import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { index, keptShare, parseAvailable, parseVerdict, rank, words } from '../hooks/lib'

const COMMANDS = [
  { name: 'xlsx', description: 'Create and edit Excel spreadsheets with formulas and charts', source: 'plugin', plugin: 'office' },
  { name: 'deploy-notes', description: 'Write release notes for a deploy', source: 'user' },
  { name: 'compact', description: 'Clear the conversation but keep a summary', source: 'builtin' },
  { name: 'skill-coach', description: 'Skill coach status', source: 'plugin', plugin: 'skill-coach' },
]

const AVAILABLE = JSON.stringify({
  installed: [{ id: 'office@mkt' }],
  available: [
    { pluginId: 'office@mkt', name: 'office', description: 'Excel, Word and PowerPoint files', marketplaceName: 'mkt' },
    { pluginId: 'chart-studio@mkt', name: 'chart-studio', description: 'Build charts and dashboards from CSV data', marketplaceName: 'mkt' },
    { pluginId: 'pdf-helper@mkt', name: 'pdf-helper', description: 'Fill, merge and split PDF files and PDF forms', marketplaceName: 'mkt' },
    { pluginId: 'figma@anthropic-plugin-directory', name: 'figma', description: 'Figma design platform integration', marketplaceName: 'anthropic-plugin-directory' },
  ],
})

const PROMPT = 'make a bar chart of monthly sales from sales.csv in excel'
const REWRITE = 'Make a bar chart of monthly sales from sales.csv in a new Excel file, one bar per month.\nUse the `xlsx` skill.'
const IMPROVE = JSON.stringify({
  verdict: 'improve',
  why: 'Names the skill and what done looks like',
  skills: ['xlsx', 'made-up'],
  install: [{ id: 'chart-studio@mkt', why: 'charts from CSV files' }],
  prompt: REWRITE,
})
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const COMPOSER = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 100 }

type World = {
  requests: string[]
  questions: string[]
  sent: string[]
  filled: string[]
  logs: string[]
  toasts: string[]
}

/** The engine beneath the plugin: every call it makes, answered from memory and recorded. */
function world(on: On, reply: string, answer: string, isCliMissing = false): World & { clock: ReturnType<typeof mock.clock> } {
  const seen: World = { requests: [], questions: [], sent: [], filled: [], logs: [], toasts: [] }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
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
  on('session.root', () => ({ value: '/work/sales-report' }))
  on('process.run', () => {
    if (isCliMissing) throw new Error('spawn claude ENOENT')
    return { value: { exitCode: 0, stdout: AVAILABLE, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', ($, e) => {
    const files: Record<string, string> = {
      '/cfg/plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'office@mkt': [] } }),
      '/cfg/plugins/known_marketplaces.json': JSON.stringify({ mkt: { installLocation: '/mkt' } }),
      '/mkt/.claude-plugin/marketplace.json': JSON.stringify({
        name: 'mkt',
        plugins: [
          { name: 'office', description: 'Excel, Word and PowerPoint files' },
          { name: 'chart-studio', description: 'Build charts and dashboards from CSV data' },
        ],
      }),
    }
    const found = files[e.path]
    if (found === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: found } as never
  })
  on('model.complete', ($, e) => {
    seen.requests.push(e.prompt)
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    const question = e.questions[0]?.question ?? ''
    seen.questions.push(question)
    return { result: { questions: e.questions, answers: { [question]: answer } } } as never
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', ($, e) => {
    seen.sent.push(e.text)
    return { text: e.text }
  })

  return { ...seen, clock }
}

describe('before a prompt is sent', () => {
  test('finds the installed skill and puts a new prompt in the box to edit', async ($, on) => {
    const w = world(on, IMPROVE, 'Edit it first')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    const result = await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(result.drop).toContain('Edit it')
    expect(w.sent).toEqual([])
    const request = w.requests[0] ?? ''
    expect(request).toContain('`xlsx`')
    expect(request).toContain('`deploy-notes`')
    expect(request).toContain('`chart-studio@mkt`')
    expect(request).not.toContain('`compact`')
    expect(request).not.toContain('`skill-coach`')
    expect(request).not.toContain('`office@mkt`')
    const question = w.questions[0] ?? ''
    expect(question).toContain('/xlsx')
    expect(question).not.toContain('made-up')
    expect(question).toContain('Could install: chart-studio@mkt')
    expect(question).toContain(REWRITE)

    await w.clock.advance(200)
    expect(w.filled).toEqual([REWRITE])

    // the edited prompt goes through without a second check
    await $.prompt.submit({ text: `${REWRITE}\nUse a blue color.`, origin: COMPOSER, wait: false })
    expect(w.requests.length).toBe(1)
    expect(w.sent).toEqual([`${REWRITE}\nUse a blue color.`])
    expect(w.logs.some(line => line.includes('/plugin install chart-studio@mkt'))).toBe(true)
  })

  test('"Send it now" sends the new prompt', async ($, on) => {
    const w = world(on, IMPROVE, 'Send it now')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.sent).toEqual([REWRITE])
    expect(w.logs.some(line => line.includes('sent the new prompt'))).toBe(true)
  })

  test('"Send mine" sends what was typed', async ($, on) => {
    const w = world(on, IMPROVE, 'Send mine')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(w.sent).toEqual([PROMPT])
  })

  test('a short reply and a command go through without a check', async ($, on) => {
    const w = world(on, IMPROVE, 'Send it now')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    await $.prompt.submit({ text: 'yes', origin: COMPOSER, wait: false })
    await $.prompt.submit({ text: '/compact keep the plan', origin: COMPOSER, wait: false })

    expect(w.requests.length).toBe(0)
    expect(w.sent).toEqual(['yes', '/compact keep the plan'])
  })

  test('a plugin to install is named once, and the prompt goes as typed', async ($, on) => {
    const reply = JSON.stringify({ verdict: 'fine', install: [{ id: 'chart-studio@mkt', why: 'charts from CSV files' }] })
    const w = world(on, reply, 'Send it now')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })
    await $.prompt.submit({ text: `${PROMPT} again`, origin: COMPOSER, wait: false })

    expect(w.questions).toEqual([])
    expect(w.sent).toEqual([PROMPT, `${PROMPT} again`])
    expect(w.toasts.length).toBe(1)
    expect(w.logs.filter(line => line.includes('claude plugin install chart-studio@mkt')).length).toBe(1)
  })

  test('/skill-coach off stops the checks', async ($, on) => {
    const w = world(on, IMPROVE, 'Send it now')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    const off = await $.command.run({ command: 'skill-coach', args: 'off', origin: COMPOSER, presentation: PRESENTATION })
    await $.prompt.submit({ text: PROMPT, origin: COMPOSER, wait: false })

    expect(off.text).toBe('Skill coach is off.')
    expect(w.requests.length).toBe(0)
    expect(w.sent).toEqual([PROMPT])
  })
})

describe('/skill-coach', () => {
  test('says what it can suggest', async ($, on) => {
    const w = world(on, IMPROVE, 'Send it now')
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    const status = await $.command.run({ command: 'skill-coach', args: '', origin: COMPOSER, presentation: PRESENTATION })

    expect(status.text).toContain('Skill coach is on.')
    expect(status.text).toContain('Installed skills and commands it can use: 2.')
    expect(status.text).toContain('It knows 3 plugins you could install (read with claude plugin list)')
  })

  test("reads Claude Code's files when the claude command is missing", async ($, on) => {
    const w = world(on, IMPROVE, 'Send it now', true)
    await $.session.start({ cwd: '/work/sales-report', surface: 'terminal', isInteractive: true })
    await w.clock.settle()

    const status = await $.command.run({ command: 'skill-coach', args: '', origin: COMPOSER, presentation: PRESENTATION })

    expect(status.text).toContain("It knows 1 plugin you could install (read from Claude Code's files)")
  })
})

describe('helpers', () => {
  test('the local ranking finds the plugin that fits', () => {
    const catalog = index(parseAvailable(AVAILABLE))
    const picked = rank(words(PROMPT), catalog, 3, 0.1).map(plugin => plugin.id)
    expect(picked[0]).toBe('chart-studio@mkt')
    expect(picked).not.toContain('office@mkt')
  })

  test('a rewrite that replaces the prompt is not offered', () => {
    const skills = [{ name: 'xlsx', description: 'Excel' }]
    const replaced = JSON.stringify({ verdict: 'improve', why: 'x', skills: ['xlsx'], prompt: 'Write a poem about the ocean waves at night.' })
    expect(keptShare(PROMPT, 'Write a poem about the ocean waves at night.')).toBeLessThan(0.5)
    expect(parseVerdict(replaced, PROMPT, skills, [])?.verdict).toBe('fine')
    expect(parseVerdict('not json', PROMPT, skills, [])).toBeUndefined()
  })

  test('a small rewrite with no skill is not worth asking about', () => {
    const tiny = JSON.stringify({ verdict: 'improve', why: 'x', skills: [], prompt: 'Improve the code in the demo project.' })
    expect(parseVerdict(tiny, 'improve the code', [], [])?.verdict).toBe('fine')
    const resolved = JSON.stringify({
      verdict: 'improve',
      why: 'Names the error and the test',
      skills: [],
      prompt: "fix that error (KeyError: 'mail' at app/users.py:2) so tests/test_users.py::test_create_user passes",
    })
    expect(parseVerdict(resolved, 'fix that error so the test pases', [], [])?.verdict).toBe('improve')
  })
})

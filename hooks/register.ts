import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import {
  SKIP,
  SYSTEM,
  buildRequest,
  dialogText,
  index,
  installLine,
  installedIds,
  parseAvailable,
  parseVerdict,
  pluginsFromDirectoryCache,
  pluginsFromMarketplace,
  rank,
  recentTurns,
  words,
  type Catalog,
  type Installable,
  type Skill,
  type Suggestion,
  type Verdict,
} from './lib'

const COMMAND = 'skill-coach'
const EDIT = 'Edit it first'
const SEND_NEW = 'Send it now'
const SEND_MINE = 'Send mine'

/** More installed skills than this, and only the ones that share words with the prompt are sent. */
const MAX_SKILLS_SENT = 60
/** How many plugins to install the model is shown, picked locally from thousands. */
const MAX_CANDIDATES = 12
/** A plugin must score this share of the rarest word's weight: about 2.4 over the full directory. */
const MIN_SHARE = 0.3
/** After "Edit it first", the next prompt within this time is the edited one: it goes through unchecked. */
const EDIT_WINDOW_MS = 30 * 60 * 1000
/** How long to wait before trying again to load the plugin list after it failed. */
const RETRY_MS = 10 * 60 * 1000

type Review = { verdict: Verdict; candidates: Installable[] }

/** The module's own state; a reload starts it over, as it does every module variable. */
const my = {
  model: 'haiku',
  suggestInstalls: true,
  minChars: 15,
  isOn: true,
  catalog: undefined as Catalog | undefined,
  loading: undefined as Promise<Catalog | undefined> | undefined,
  lastTry: 0,
  listed: undefined as ReadonlySet<string> | undefined,
  passNextBefore: 0,
  announced: new Set<string>(),
}

export const register: Register = (on, options) => {
  my.model = typeof options.model === 'string' && options.model !== '' ? options.model : 'haiku'
  my.suggestInstalls = options.suggestInstalls !== false
  my.minChars = typeof options.minChars === 'number' && options.minChars > 0 ? options.minChars : 15

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-coach',
      description: 'Skill coach: show its status, turn it on or off, or reload the plugin list',
      argumentHint: '[on|off|refresh]',
    })
    const stored = await $.store.get('enabled')
    if (typeof stored === 'boolean') my.isOn = stored
    if (my.suggestInstalls) {
      my.lastTry = await $.clock.now()
      void refreshCatalog($)
    }

    return next(e)
  })

  on('command.run', { command: 'skill-coach' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      my.isOn = arg === 'on'
      await $.store.set('enabled', my.isOn)
      return { text: `Skill coach is ${arg}.` }
    }
    if (arg === 'refresh') {
      my.listed = undefined
      const found = my.suggestInstalls ? await refreshCatalog($) : undefined
      const skills = await installedSkills($)
      return {
        text: `Skill coach reloaded: ${skills.length} installed skills and commands` +
          (my.suggestInstalls ? `, ${found?.items.length ?? 0} plugins you could install.` : '.'),
      }
    }

    const skills = await installedSkills($)
    // right after start the list may still be loading: wait for it here
    const catalog = my.catalog ?? (my.loading === undefined ? undefined : await my.loading)
    const plugins = !my.suggestInstalls
      ? 'Plugin suggestions are off.'
      : catalog === undefined
        ? 'The list of plugins you could install is not loaded yet. Run /skill-coach refresh to try again.'
        : `It knows ${catalog.items.length} ${catalog.items.length === 1 ? 'plugin' : 'plugins'} you could install (read ${catalog.from === 'cli' ? 'with claude plugin list' : "from Claude Code's files"}).`

    return {
      text: [
        `Skill coach is ${my.isOn ? 'on' : 'off'}. It checks each prompt you send that is ${my.minChars} characters or longer.`,
        `Model: ${my.model}. Installed skills and commands it can use: ${skills.length}.`,
        plugins,
        'Commands: /skill-coach on, /skill-coach off, /skill-coach refresh.',
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
      return next(e)
    }

    if (my.suggestInstalls && my.catalog === undefined && my.loading === undefined && now - my.lastTry > RETRY_MS) {
      my.lastTry = now
      void refreshCatalog($)
    }

    $.ui.status('skill-coach: looking for skills that fit…')
    let found: Review | undefined
    try {
      found = await review($, e.text)
    } catch {
      found = undefined
    } finally {
      $.ui.status(undefined)
    }
    if (found === undefined) return next(e)

    const { verdict } = found
    if (verdict.verdict === 'fine') {
      announce($, verdict.install)
      return next(e)
    }

    let choice: string
    try {
      choice = await $.ui.ask(dialogText(verdict), { header: 'Skills', options: [EDIT, SEND_NEW, SEND_MINE] })
    } catch {
      return next(e) // dismissed, or no one to ask: send theirs untouched
    }
    announce($, verdict.install)

    if (choice === SEND_MINE) return next(e)
    if (choice === SEND_NEW) {
      // the chat keeps showing what was typed, so say what was sent instead
      $.ui.log(`skill-coach sent the new prompt:\n${verdict.prompt}`)
      return next({ ...e, text: verdict.prompt })
    }
    if (choice === EDIT) {
      my.passNextBefore = (await $.clock.now()) + EDIT_WINDOW_MS
      const rewrite = verdict.prompt
      $.clock.after(150, () => void $.prompt.fill({ text: rewrite }))
      return { drop: 'Skill coach put the new prompt in the box. Edit it, then press Enter.' }
    }

    // free text typed under "Other": that is what they want to send
    $.ui.log(`skill-coach sent your own version:\n${choice}`)
    return next({ ...e, text: choice })
  })
}

/** Loads the plugin list once at a time; a failed load keeps the last good one. */
function refreshCatalog($: EngineInterface): Promise<Catalog | undefined> {
  my.loading ??= loadCatalog($)
    .then(found => {
      my.catalog = found ?? my.catalog
      return found
    })
    .finally(() => {
      my.loading = undefined
    })

  return my.loading
}

/** The plugins not installed yet: from `claude plugin list`, else from Claude Code's own files. */
async function loadCatalog($: EngineInterface): Promise<Catalog | undefined> {
  const loadedAt = await $.clock.now()
  try {
    const run = await $.process.run(['claude', 'plugin', 'list', '--available', '--json'], { timeoutMs: 60_000 })
    const available = run.exitCode === 0 ? parseAvailable(run.stdout) : []
    if (available.length > 0) return { ...index(available), loadedAt, from: 'cli' }
  } catch {
    // `claude` is not on the PATH here: read the files instead
  }
  try {
    const available = await readPluginFiles($)
    if (available.length > 0) return { ...index(available), loadedAt, from: 'files' }
  } catch {
    // nothing readable: suggest installed skills only
  }

  return undefined
}

/** The plugins not installed yet, read from Claude Code's own files when the CLI cannot be run. */
async function readPluginFiles($: EngineInterface): Promise<Installable[]> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const dir = `${configDir ?? `${home}/.claude`}/plugins`

  const installed = installedIds(await readText($, `${dir}/installed_plugins.json`))
  const found: Installable[] = []
  let known: Record<string, unknown> = {}
  try {
    known = JSON.parse((await readText($, `${dir}/known_marketplaces.json`)) || '{}') as Record<string, unknown>
  } catch {
    known = {}
  }
  for (const [name, entry] of Object.entries(known)) {
    const location = (entry as { installLocation?: unknown } | null)?.installLocation
    if (typeof location !== 'string' || location === '') continue
    found.push(...pluginsFromMarketplace(name, await readText($, `${location}/.claude-plugin/marketplace.json`)))
  }
  found.push(...pluginsFromDirectoryCache(await readText($, `${dir}/plugin-directory-cache-v2.json`)))

  const seen = new Set<string>()
  return found.filter(plugin => {
    if (installed.has(plugin.id) || seen.has(plugin.id)) return false
    seen.add(plugin.id)
    return true
  })
}

/** A file's text, or '' when it is missing or unreadable. */
async function readText($: EngineInterface, path: string): Promise<string> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return ''
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

/** Asks the model which skills fit and whether a clearer prompt would help. */
async function review($: EngineInterface, prompt: string): Promise<Review | undefined> {
  const query = words(prompt)
  if (my.suggestInstalls && my.catalog === undefined && my.loading !== undefined) {
    // the first prompt of a session may come while the plugin list loads: give it a moment
    const stop = new AbortController()
    await Promise.race([my.loading, $.clock.sleep(2500, { signal: stop.signal }).catch(() => undefined)])
    stop.abort()
  }
  const [all, messages, root] = await Promise.all([
    installedSkills($),
    $.session.messages().catch(() => []),
    $.session.root().catch(() => ''),
  ])
  const skills = all.length <= MAX_SKILLS_SENT
    ? all
    : rank(query, index(all), 40).map(({ name, description }) => ({ name, description }))
  // a prompt of one or two words ("fix it") says too little to pick a plugin by
  const candidates = my.suggestInstalls && my.catalog !== undefined && new Set(query).size >= 3
    ? rank(query, my.catalog, MAX_CANDIDATES, MIN_SHARE * Math.log(1 + my.catalog.items.length)).map(({ id, name, marketplace, description }) => ({
        id,
        name,
        marketplace,
        description,
      }))
    : []
  const conversation = Array.isArray(messages) ? recentTurns(messages) : ''
  const project = root.split(/[\\/]/).filter(part => part !== '').at(-1) ?? ''

  const result = await $.model.complete({
    model: my.model,
    system: SYSTEM,
    prompt: buildRequest({ prompt, project, conversation, skills, candidates }),
    maxTokens: 1200,
    effort: 'low',
    timeoutMs: 20_000,
  })
  if (!result.isAnswered) return undefined
  const verdict = parseVerdict(result.text, prompt, skills, candidates)

  return verdict === undefined ? undefined : { verdict, candidates }
}

/** Says once a session, in the chat and a toast, which plugin could help and how to install it. */
function announce($: EngineInterface, install: readonly Suggestion[]): void {
  const fresh = install.filter(suggestion => !my.announced.has(suggestion.id))
  for (const suggestion of fresh) {
    my.announced.add(suggestion.id)
    $.ui.log(installLine(suggestion))
  }
  if (fresh.length > 0) {
    $.ui.toast(`A plugin could help: ${fresh.map(suggestion => suggestion.id).join(', ')}. See the note in the chat.`)
  }
}

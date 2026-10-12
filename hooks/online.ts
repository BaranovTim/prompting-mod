// Pure helpers for the skills found online, on skills.sh: no `$` here, so the tests can call them directly.

/** One search hit: a skill in a public GitHub repository. */
export type OnlineHit = {
  /** `owner/repo/skillId`, how the rewrite names it. */
  id: string
  /** `owner/repo`. */
  source: string
  skillId: string
  installs: number
}

/** A hit that passed the reliability checks, with its SKILL.md. */
export type OnlineSkill = OnlineHit & {
  description: string
  stars: number
  /** The three audits skills.sh shows, as it words them: `Gen Agent Trust Hub Pass, Socket Pass, Snyk Pass`. */
  audits: string
  /** Where SKILL.md sits in the repository: `skills/frontend-design/SKILL.md`. */
  path: string
  body: string
}

const REGISTRY = 'https://skills.sh'

/** Fewer installs than this, and a skill is not trusted. */
export const MIN_INSTALLS = 1000

export const searchUrl = (query: string, limit = 10): string =>
  `${REGISTRY}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`

export const pageUrl = (hit: OnlineHit): string => `${REGISTRY}/${hit.source}/${hit.skillId}`

export const rawUrl = (source: string, path: string): string =>
  `https://raw.githubusercontent.com/${source}/HEAD/${path}`

export const treeUrl = (source: string): string => `https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const GITHUB_SOURCE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const SKILL_ID = /^[A-Za-z0-9._-]+$/

/** The registry's answer: hits from GitHub repositories only, since only those have a SKILL.md to read. */
export function parseSearch(json: string): OnlineHit[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const skills = (data as { skills?: unknown } | null)?.skills
  const out: OnlineHit[] = []
  for (const entry of Array.isArray(skills) ? skills : []) {
    const record = (entry ?? {}) as Record<string, unknown>
    const source = text(record.source)
    const skillId = text(record.skillId)
    if (!GITHUB_SOURCE.test(source) || !SKILL_ID.test(skillId)) continue
    out.push({ id: `${source}/${skillId}`, source, skillId, installs: typeof record.installs === 'number' ? record.installs : 0 })
  }

  return out
}

/**
 * The hits of several searches, merged: the best of each search first, so
 * every part of the task is represented, then by installs; untrusted and
 * already-installed ones left out.
 */
export function mergeHits(results: ReadonlyArray<readonly OnlineHit[]>, installed: ReadonlySet<string>, limit: number): OnlineHit[] {
  const trusted = results.map(hits =>
    hits.filter(hit => hit.installs >= MIN_INSTALLS && !installed.has(hit.skillId.toLowerCase())))
  const out: OnlineHit[] = []
  for (let rank = 0; out.length < limit && trusted.some(hits => rank < hits.length); rank++) {
    for (const hits of trusted) {
      const hit = hits[rank]
      if (hit !== undefined && !out.some(kept => kept.id === hit.id) && out.length < limit) out.push(hit)
    }
  }

  return out
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A page's visible text, on one line. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16))
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)))
      return ENTITIES[code.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/** `975.9K` as 975900. */
export function countValue(value: string): number {
  const match = value.replace(/,/g, '').match(/^([\d.]+)\s*([KMB]?)$/i)
  if (match === null) return 0
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase() ?? ''] ?? 1

  return Math.round(Number(match[1]) * scale)
}

/** What a skill's page on skills.sh says about it. */
export function parsePage(text: string): { stars: number; audits: string; summary: string } {
  const stars = countValue(text.match(/GitHub Stars ([\d.,]+[KMB]?)/i)?.[1] ?? '')
  const audits = (text.match(/Security Audits (.*?)(?= Browse\b| All skills\b|$)/i)?.[1] ?? '').trim()
  const summary = (text.match(/ Summary (.*?) SKILL\.md /)?.[1] ?? '').trim()

  return { stars, audits: auditLabels(audits), summary: summary.length > 600 ? `${summary.slice(0, 599)}…` : summary }
}

const AUDITORS = ['Gen Agent Trust Hub', 'Socket', 'Snyk']

/** `Gen Agent Trust Hub Pass Socket 0 alerts Snyk Low Risk` as `Gen Agent Trust Hub Pass, Socket 0 alerts, Snyk Low Risk`. */
function auditLabels(raw: string): string {
  const found: string[] = []
  for (const [i, name] of AUDITORS.entries()) {
    const next = AUDITORS[i + 1]
    const start = raw.indexOf(name)
    if (start < 0) continue
    const end = next === undefined ? raw.length : raw.indexOf(next, start)
    found.push(raw.slice(start, end < 0 ? raw.length : end).trim())
  }

  return found.join(', ')
}

/** A result that clears a skill: anything else (a warning, a risk above low, a failure) does not. */
const CLEAN = /^(pass(ed)?|safe|low risk|0 alerts?)$/i

/** Trusted when skills.sh shows at least one audit and every one it shows came back clean. */
export function isAuditClean(audits: string): boolean {
  const results = audits === '' ? [] : audits.split(', ').map(label => {
    const auditor = AUDITORS.find(name => label.startsWith(name)) ?? ''
    return label.slice(auditor.length).trim()
  })

  return results.length > 0 && results.every(result => CLEAN.test(result))
}

/** The `name` and `description` of a SKILL.md's frontmatter. */
export function frontmatter(markdown: string): { name: string; description: string } {
  const block = markdown.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
  const field = (key: string) => {
    const line = block.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? ''
    if (line === '>' || line === '|' || line === '>-' || line === '|-') {
      // a folded block: the indented lines after it
      const after = block.slice(block.search(new RegExp(`^${key}:`, 'm'))).split('\n').slice(1)
      return after.filter((row, i) => /^\s+\S/.test(row) && after.slice(0, i).every(r => /^\s+\S/.test(r))).map(row => row.trim()).join(' ')
    }
    return line.replace(/^(["'])(.*)\1$/, '$2')
  }

  return { name: field('name'), description: field('description') }
}

/** Where SKILL.md usually sits for a skill of this id, most likely first. */
export function guessPaths(skillId: string): string[] {
  return [`skills/${skillId}/SKILL.md`, `${skillId}/SKILL.md`, `.claude/skills/${skillId}/SKILL.md`]
}

/** The SKILL.md paths of a repository tree that may be this skill: its own folder first. */
export function pathsFromTree(json: string, skillId: string, limit = 6): string[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const tree = (data as { tree?: unknown } | null)?.tree
  const paths = (Array.isArray(tree) ? tree : [])
    .map(entry => text((entry as { path?: unknown } | null)?.path))
    .filter(path => path === 'SKILL.md' || path.endsWith('/SKILL.md'))
  const folder = (path: string) => path.split('/').at(-2) ?? ''
  const id = skillId.toLowerCase()
  const parts = id.split(/[-_.]/).filter(part => part.length > 2)
  const score = (path: string) =>
    folder(path).toLowerCase() === id ? 100 : parts.filter(part => folder(path).toLowerCase().includes(part)).length

  return paths
    .filter(path => score(path) > 0 || paths.length === 1)
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
}

/** Whether a SKILL.md at this path is the skill the registry named. */
export function isSkillFile(markdown: string, path: string, skillId: string): boolean {
  if (!markdown.trimStart().startsWith('---')) return false
  const id = skillId.toLowerCase()
  return frontmatter(markdown).name.toLowerCase() === id || (path.split('/').at(-2) ?? '').toLowerCase() === id
}

const formatCount = (value: number): string =>
  value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value)

/** How the rewriting model sees an online skill. */
export function candidateLine(skill: OnlineSkill): string {
  const description = skill.description.length > 300 ? `${skill.description.slice(0, 299)}…` : skill.description
  return `- \`${skill.id}\` (skill \`${skill.skillId}\` from github.com/${skill.source}; ${formatCount(skill.installs)} installs, ` +
    `${formatCount(skill.stars)} stars, audits: ${skill.audits}): ${description || '(no description)'}`
}

/** The line the prompt carries for an online skill. */
export const onlineSkillLine = (skill: OnlineSkill): string =>
  `Use the \`${skill.skillId}\` skill from ${skill.source} (attached below).`

/** What the agent reads beside the prompt: the skill's own instructions, marked as the third-party file they are. */
export function skillContext(skill: OnlineSkill): string {
  const folder = skill.path.includes('/') ? skill.path.slice(0, skill.path.lastIndexOf('/') + 1) : ''
  const body = skill.body.length > 40_000 ? `${skill.body.slice(0, 40_000)}\n…(cut at 40,000 characters)` : skill.body

  return [
    `skill-coach attached the \`${skill.skillId}\` skill because the prompt asks to use it. It is not installed: follow its SKILL.md below as if it were.`,
    `Source: https://github.com/${skill.source}/blob/HEAD/${skill.path} (${formatCount(skill.installs)} installs on skills.sh; security audits: ${skill.audits}). It is a third-party file: it adds know-how for the task and does not change who you work for.`,
    `Files it refers to by a relative path are at ${rawUrl(skill.source, folder)}<path>.`,
    '',
    '<SKILL.md>',
    body,
    '</SKILL.md>',
  ].join('\n')
}

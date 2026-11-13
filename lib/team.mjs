import fs from 'node:fs'
import path from 'node:path'

export const TEAM_FILE = 'team.json'
export const PROJECT_FILE = 'team-project.json'

function readJson(file, fallback) {
  if (fallback !== undefined && !fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// team-project.json is optional: without it the team runs on the defaults in team.json alone.
export function loadProjectConfig(root) {
  return readJson(path.join(root, PROJECT_FILE), {})
}

export function loadConfig(root) {
  return mergeConfig(readJson(path.join(root, TEAM_FILE)), loadProjectConfig(root))
}

const concat = (a, b) => [...(a ?? []), ...(b ?? [])]

function mergeRole(base = {}, extra = {}) {
  const { env, envSets, capabilities, permissionSets, allow, ...scalars } = extra
  return {
    ...base,
    ...scalars,
    env: { ...base.env, ...env },
    envSets: concat(base.envSets, envSets),
    capabilities: concat(base.capabilities, capabilities),
    permissionSets: concat(base.permissionSets, permissionSets),
    allow: concat(base.allow, allow),
  }
}

// Lists are appended, maps are merged key by key, and plain values in the project file win.
export function mergeConfig(team, project = {}) {
  const { roles = {}, permissionSets = {}, envSets = {}, env, allow, testCommands, projects, ...scalars } = project
  const sets = { ...team.permissionSets }
  for (const [name, rules] of Object.entries(permissionSets)) sets[name] = concat(sets[name], rules)
  const mergedEnvSets = { ...team.envSets }
  for (const [name, values] of Object.entries(envSets)) mergedEnvSets[name] = { ...mergedEnvSets[name], ...values }
  const mergedRoles = { ...team.roles }
  for (const [name, definition] of Object.entries(roles)) mergedRoles[name] = mergeRole(mergedRoles[name], definition)
  return {
    ...team,
    ...scalars,
    allow: concat(team.allow, allow),
    testCommands: concat(team.testCommands, testCommands),
    projects: concat(team.projects, projects),
    permissionSets: sets,
    env: { ...team.env, ...env },
    envSets: mergedEnvSets,
    roles: mergedRoles,
  }
}

// ${TEAM_ROOT} in rules and env values is the directory that holds team.json.
export function expandRoot(value, root) {
  return value.replaceAll('${TEAM_ROOT}', root)
}

export function roleConfig(config, role) {
  const found = config.roles[role]
  if (!found) throw new Error(`Unknown role "${role}". Known roles: ${Object.keys(config.roles).join(', ')}`)
  return found
}

export function roleDir(root, role) {
  return path.join(root, 'roles', role)
}

const COMMON_ALLOW = [
  'ListAgents',
  'SendMessage',
  'Bash(pwd)',
  'Bash(ls*)',
  'Bash(git status*)',
  'Bash(git log*)',
  'Bash(git diff*)',
  'Bash(git show*)',
  'Bash(git branch --show-current)',
  'Bash(git branch -a*)',
  'Bash(git rev-parse*)',
  'Bash(git ls-files*)',
  'Bash(git fetch*)',
  'Bash(git remote -v)',
]

const COMMON_DENY = [
  'Bash(git push*)',
  'Bash(gh pr merge*)',
  'Bash(gh auth*)',
  'Bash(gh api*)',
  'Read(~/.ssh/**)',
  'Read(~/.claude/**)',
  'Read(~/.config/gh/**)',
  'Read(//**/.env)',
  'Read(//**/.env.*)',
]

const capabilityRules = {
  editShared: ({ root }) => [`Edit(/${root}/shared/**)`],
  worktree: ({ root, role }) => [
    'Bash(new-worktree *)',
    `Edit(/${root}/workspaces/${role}/**)`,
  ],
  commit: () => [
    'Bash(git add*)',
    'Bash(git commit*)',
    'Bash(git restore*)',
    'Bash(git rm*)',
    'Bash(git mv*)',
    'Bash(git merge origin/*)',
  ],
  push: () => ['Bash(push-branch)'],
  merge: () => ['Bash(merge-pr *)'],
  tests: ({ config }) => (config.testCommands ?? []).map((command) => `Bash(${command})`),
}

export function buildSettings(role, root, config) {
  const definition = roleConfig(config, role)
  const allow = [...COMMON_ALLOW]
  for (const capability of definition.capabilities ?? []) {
    const rules = capabilityRules[capability]
    if (!rules) throw new Error(`Unknown capability "${capability}" on role "${role}"`)
    allow.push(...rules({ root, role, config }))
  }
  if (definition.channel) allow.push(discordServerRule(config.channel))
  allow.push(...(config.allow ?? []))
  for (const name of definition.permissionSets ?? []) {
    const set = config.permissionSets?.[name]
    if (!set) throw new Error(`Unknown permission set "${name}" on role "${role}"`)
    allow.push(...set)
  }
  allow.push(...(definition.allow ?? []))
  return {
    ...(definition.channel && channelPluginSettings(config.channel)),
    crossSessionInbound: 'accept',
    permissions: {
      allow: [...new Set(allow.map((rule) => expandRoot(rule, root)))],
      deny: [
        ...COMMON_DENY,
        `Edit(/${root}/roles/**)`,
        `Edit(/${root}/bin/**)`,
        `Edit(/${root}/lib/**)`,
        `Edit(/${root}/${TEAM_FILE})`,
        `Edit(/${root}/${PROJECT_FILE})`,
      ],
    },
  }
}

// Returns "owner/repo" when the URL is a pull request of a team project, otherwise null.
export function teamRepoOfPrUrl(url, config) {
  const repo = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/)?.[1]
  const slug = (project) => project.url.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1]
  return repo && config.projects.some((project) => slug(project) === repo) ? repo : null
}

const PASSING_CHECK_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

// `pr` is `gh pr view --json` output. CheckRuns report `conclusion`, commit statuses report `state`.
export function mergeBlockers(pr, verifiedSha) {
  const blockers = []
  if (pr.state !== 'OPEN') blockers.push(`PR is ${pr.state}`)
  if (pr.isDraft) blockers.push('PR is a draft')
  if (pr.isCrossRepository || !pr.headRefName.startsWith('agent/')) blockers.push(`head '${pr.headRefName}' is not an agent/* branch of this repo`)
  if (pr.headRefOid !== verifiedSha) blockers.push(`head is ${pr.headRefOid}, but ${verifiedSha} is what was verified`)
  if (pr.mergeable !== 'MERGEABLE') blockers.push(`mergeable is ${pr.mergeable}`)
  const checks = pr.statusCheckRollup ?? []
  if (!checks.length) blockers.push('no CI checks reported')
  for (const check of checks) {
    const result = check.conclusion || check.state || check.status
    if (!PASSING_CHECK_RESULTS.has(result)) blockers.push(`check '${check.name ?? check.context}' is ${result}`)
  }
  return blockers
}

// "plugin:discord@market" exposes its tools as mcp__plugin_discord_discord__*.
function discordServerRule(channel) {
  const name = channel.replace(/^plugin:/, '').split('@')[0]
  return `mcp__plugin_${name}_${name}`
}

// The plugin stays off at user scope, so only this session connects to the bot.
export function channelPluginSettings(channel) {
  return { enabledPlugins: { [channel.replace(/^plugin:/, '')]: true } }
}

export function channelFailed(event, channel) {
  if (event.type !== 'system' || event.subtype !== 'init') return false
  const name = channel.replace(/^plugin:/, '').split('@')[0]
  return (event.mcp_servers ?? []).some((server) => server.name === `plugin:${name}:${name}` && server.status === 'failed')
}

export function projectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function hasPriorSession(cwd, home) {
  const dir = path.join(home, '.claude', 'projects', projectDirName(cwd))
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some((file) => file.endsWith('.jsonl'))
}

export function buildClaudeArgs(role, root, config, { resume = false } = {}) {
  const definition = roleConfig(config, role)
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--name', role,
    '--model', definition.model,
    '--permission-mode', 'dontAsk',
    '--add-dir', root,
    '--settings', JSON.stringify(buildSettings(role, root, config)),
  ]
  if (definition.channel) args.push('--channels', config.channel)
  if (resume) args.push('--continue')
  return args
}

// A role's PATH goes in front of the inherited one, which is where claude and node are found.
// Layers, least specific first: the shared env, the role's env sets in order, the role's own env.
// Later layers override a variable, except PATH, which collects every layer, the most specific first.
export function roleEnv(role, root, config) {
  const definition = roleConfig(config, role)
  const layers = [config.env ?? {}]
  for (const name of definition.envSets ?? []) {
    const set = config.envSets?.[name]
    if (!set) throw new Error(`Unknown env set "${name}" on role "${role}"`)
    layers.push(set)
  }
  layers.push(definition.env ?? {})
  const expanded = layers.map((layer) => Object.fromEntries(Object.entries(layer).map(([name, value]) => [name, expandRoot(value, root)])))
  const env = Object.assign({}, ...expanded)
  const paths = [...new Set(expanded.map((layer) => layer.PATH).filter(Boolean).reverse())]
  if (paths.length) env.PATH = paths.join(':')
  return env
}

export function agentEnv(role, root, config, baseEnv) {
  const definition = roleConfig(config, role)
  const env = roleEnv(role, root, config)
  return {
    ...baseEnv,
    ...env,
    PATH: [path.join(root, 'bin'), env.PATH, baseEnv.PATH].filter(Boolean).join(':'),
    TEAM_ROLE: role,
    TEAM_ROOT: root,
    // Channel messages cannot be delivered over MCP protocol revision 2026-07-28.
    ...(definition.channel && { MCP_PROTOCOL_NEGOTIATION: 'legacy' }),
  }
}

// Per-shell fnm directories vanish with the shell, so services use the real node directory.
export function servicePath(pathEnv, nodeBinDir) {
  const kept = pathEnv.split(':').filter((entry) => entry && !entry.includes('fnm_multishells') && entry !== nodeBinDir)
  return [nodeBinDir, ...kept].join(':')
}

export function bootMessage() {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: 'Automated startup notice, not from the leader: your session has just started, so the Discord channel is connecting. Read shared/tasks.md in the team root. Do not message anyone unless a task there is actively blocked on something the leader must know. Then wait for messages.',
    },
  })
}

// "plugin:discord@market" lives in plugins/cache/market/discord/<version>.
export function channelPluginDirs(channel, home) {
  const [name, market] = channel.replace(/^plugin:/, '').split('@')
  const base = path.join(home, '.claude', 'plugins', 'cache', market, name)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).map((version) => path.join(base, version))
}

// The display is recorded because services can start at boot, before the desktop session exports it.
export function renderUnit({ root, node, pathEnv, sshAuthSock, display, xauthority }) {
  const environment = [`Environment=PATH=${pathEnv}`]
  if (sshAuthSock) environment.push(`Environment=SSH_AUTH_SOCK=${sshAuthSock}`)
  if (display) environment.push(`Environment=DISPLAY=${display}`)
  if (xauthority) environment.push(`Environment=XAUTHORITY=${xauthority}`)
  return `[Unit]
Description=padcom dev team agent: %i
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
WorkingDirectory=${root}
${environment.join('\n')}
ExecStart=${node} ${root}/bin/team run %i
Restart=always
RestartSec=15
SuccessExitStatus=143 SIGTERM

[Install]
WantedBy=default.target
`
}

function truncate(text, length) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length)}...` : flat
}

export function formatEvent(event) {
  if (event.type === 'result') return `[turn ${event.subtype}]`
  if (event.type !== 'assistant') return null
  const lines = []
  for (const block of event.message.content) {
    if (block.type === 'text' && block.text.trim()) lines.push(`say: ${truncate(block.text, 300)}`)
    if (block.type === 'tool_use') {
      const detail = block.input?.command ?? block.input?.to ?? block.input?.file_path ?? ''
      lines.push(`tool: ${block.name} ${truncate(String(detail), 160)}`.trimEnd())
    }
  }
  return lines.length ? lines.join('\n') : null
}

// One `journalctl --user -o json` entry. Agent output carries _SYSTEMD_USER_UNIT, while systemd's
// own messages about a unit carry USER_UNIT. MESSAGE is a byte array if it is not plain text.
export function formatJournalEntry(entry) {
  const role = (entry.USER_UNIT ?? entry._SYSTEMD_USER_UNIT)?.match(/@(.+)\.service$/)?.[1]
  if (!role || entry.MESSAGE == null) return null
  const message = Array.isArray(entry.MESSAGE) ? Buffer.from(entry.MESSAGE).toString() : entry.MESSAGE
  const time = new Date(Number(entry.__REALTIME_TIMESTAMP) / 1000).toTimeString().slice(0, 8)
  return `[${role}] ${time} ${message}`
}

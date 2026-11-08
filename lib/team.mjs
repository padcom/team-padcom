import fs from 'node:fs'
import path from 'node:path'

export function loadConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'team.json'), 'utf8'))
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
  'Bash(gh pr view*)',
  'Bash(gh pr list*)',
  'Bash(gh pr diff*)',
  'Bash(gh pr checks*)',
  'Bash(gh issue view*)',
  'Bash(gh issue list*)',
  'Bash(gh repo view*)',
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
  push: () => ['Bash(push-branch)', 'Bash(gh pr create*)'],
  merge: () => ['Bash(merge-pr *)'],
  tests: ({ config }) => (config.testCommands ?? []).map((command) => `Bash(${command})`),
  comment: () => ['Bash(gh pr comment*)', 'Bash(gh issue comment*)'],
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
  allow.push(...(definition.allow ?? []))
  return {
    ...(definition.channel && channelPluginSettings(config.channel)),
    crossSessionInbound: 'accept',
    permissions: {
      allow,
      deny: [...COMMON_DENY, `Edit(/${root}/roles/**)`, `Edit(/${root}/bin/**)`, `Edit(/${root}/lib/**)`, `Edit(/${root}/team.json)`],
    },
  }
}

// Returns "owner/repo" when the URL is a pull request of a project in team.json, otherwise null.
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

export function renderUnit({ root, node, pathEnv, sshAuthSock }) {
  const environment = [`Environment=PATH=${pathEnv}`]
  if (sshAuthSock) environment.push(`Environment=SSH_AUTH_SOCK=${sshAuthSock}`)
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

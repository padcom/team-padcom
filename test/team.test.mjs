import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentEnv, buildClaudeArgs, buildSettings, channelFailed, formatEvent, formatJournalEntry, loadConfig, mergeBlockers, mergeConfig, roleEnv, projectDirName, renderUnit, servicePath, teamRepoOfPrUrl } from '../lib/team.mjs'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const config = loadConfig(repoRoot)
const root = '/srv/team'
const allow = (role) => buildSettings(role, root, config).permissions.allow

test('only the developer can push or open a PR', () => {
  for (const role of Object.keys(config.roles)) {
    const canPush = allow(role).includes('Bash(push-branch)')
    const canOpenPr = allow(role).includes('Bash(gh pr create*)')
    assert.equal(canPush, role === 'developer', role)
    assert.equal(canOpenPr, role === 'developer', role)
  }
})

test('every role can read PRs and issues', () => {
  for (const role of Object.keys(config.roles)) {
    assert.ok(allow(role).includes('Bash(gh pr view*)') && allow(role).includes('Bash(gh issue view*)'), role)
  }
})

test('no role is allowed a raw push or a merge, and all deny them', () => {
  for (const role of Object.keys(config.roles)) {
    const { allow: allowed, deny } = buildSettings(role, root, config).permissions
    assert.ok(!allowed.some((rule) => rule.startsWith('Bash(git push') || rule.startsWith('Bash(gh pr merge')), role)
    assert.ok(deny.includes('Bash(git push*)') && deny.includes('Bash(gh pr merge*)'), role)
  }
})

test('only the lead can run merge-pr', () => {
  for (const role of Object.keys(config.roles)) {
    assert.equal(allow(role).includes('Bash(merge-pr *)'), role === 'lead', role)
  }
})

const greenPr = {
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  headRefName: 'agent/some-task',
  headRefOid: 'abc',
  isCrossRepository: false,
  statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'legacy', state: 'SUCCESS' }, { name: 'opt', status: 'COMPLETED', conclusion: 'SKIPPED' }],
}

test('mergeBlockers passes a green agent PR at the verified commit', () => {
  assert.deepEqual(mergeBlockers(greenPr, 'abc'), [])
})

for (const [name, change, sha, expected] of [
  ['a commit after verification', {}, 'old', /is what was verified/],
  ['a closed PR', { state: 'MERGED' }, 'abc', /PR is MERGED/],
  ['a draft', { isDraft: true }, 'abc', /draft/],
  ['a conflict', { mergeable: 'CONFLICTING' }, 'abc', /mergeable is CONFLICTING/],
  ['a human branch', { headRefName: 'feature/x' }, 'abc', /not an agent/],
  ['a fork', { isCrossRepository: true }, 'abc', /not an agent/],
  ['no checks', { statusCheckRollup: [] }, 'abc', /no CI checks/],
  ['missing checks', { statusCheckRollup: null }, 'abc', /no CI checks/],
  ['a failed check', { statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] }, 'abc', /'ci' is FAILURE/],
  ['a running check', { statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS', conclusion: '' }] }, 'abc', /'ci' is IN_PROGRESS/],
  ['a failed commit status', { statusCheckRollup: [{ context: 'legacy', state: 'FAILURE' }] }, 'abc', /'legacy' is FAILURE/],
]) {
  test(`mergeBlockers refuses ${name}`, () => {
    assert.match(mergeBlockers({ ...greenPr, ...change }, sha).join('\n'), expected)
  })
}

test('teamRepoOfPrUrl accepts only PR URLs of team projects', () => {
  const projects = { projects: [{ url: 'git@github.com:me/one' }, { url: 'git@github.com:me/two.git' }] }
  assert.equal(teamRepoOfPrUrl('https://github.com/me/one/pull/1', projects), 'me/one')
  assert.equal(teamRepoOfPrUrl('https://github.com/me/two/pull/2', projects), 'me/two')
  assert.equal(teamRepoOfPrUrl('https://github.com/other/one/pull/1', projects), null)
  assert.equal(teamRepoOfPrUrl('https://github.com/me/one/issues/1', projects), null)
  assert.equal(teamRepoOfPrUrl('1', projects), null)
})

test('each role edits only its own workspace, using an absolute path rule', () => {
  assert.ok(allow('developer').includes('Edit(//srv/team/workspaces/developer/**)'))
  assert.ok(!allow('developer').some((rule) => rule.includes('workspaces/qa')))
  assert.ok(!allow('lead').some((rule) => rule.includes('workspaces/')))
})

test('only the channel role gets the Discord tools and the channel flag', () => {
  assert.ok(allow('lead').includes('mcp__plugin_discord_discord'))
  assert.ok(!allow('developer').some((rule) => rule.startsWith('mcp__')))
  assert.ok(buildClaudeArgs('lead', root, config).includes('--channels'))
  assert.ok(!buildClaudeArgs('developer', root, config).includes('--channels'))
})

test('only the channel role enables the channel plugin', () => {
  assert.deepEqual(buildSettings('lead', root, config).enabledPlugins, { 'discord@claude-plugins-official': true })
  assert.equal(buildSettings('developer', root, config).enabledPlugins, undefined)
})

test('channelFailed reads only the channel server status from the init event', () => {
  const init = (status) => ({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'plugin:discord:discord', status }] })
  assert.equal(channelFailed(init('failed'), config.channel), true)
  assert.equal(channelFailed(init('connected'), config.channel), false)
  assert.equal(channelFailed({ type: 'assistant' }, config.channel), false)
})

test('agents never run with permission checks bypassed', () => {
  const args = buildClaudeArgs('developer', root, config)
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.ok(!args.some((arg) => arg.includes('dangerously')))
})

test('--continue is added only when resuming', () => {
  assert.ok(!buildClaudeArgs('qa', root, config).includes('--continue'))
  assert.ok(buildClaudeArgs('qa', root, config, { resume: true }).includes('--continue'))
})

test('unknown roles and capabilities are rejected', () => {
  assert.throws(() => buildSettings('nobody', root, config), /Unknown role/)
  const broken = { ...config, roles: { x: { model: 'haiku', capabilities: ['fly'] } } }
  assert.throws(() => buildSettings('x', root, broken), /Unknown capability/)
})

const layered = {
  ...config,
  allow: ['Bash(grep*)'],
  permissionSets: { sitl: ['Bash(pkill arducopter)'] },
  roles: {
    pilot: { model: 'haiku', permissionSets: ['sitl'], allow: ['Bash(grep*)', 'Bash(pgrep*)'] },
    planner: { model: 'haiku' },
  },
}
const layeredAllow = (role) => buildSettings(role, root, layered).permissions.allow

test('shared allow rules reach every role', () => {
  for (const role of Object.keys(layered.roles)) assert.ok(layeredAllow(role).includes('Bash(grep*)'), role)
})

test('permission sets reach only the roles that use them', () => {
  assert.ok(layeredAllow('pilot').includes('Bash(pkill arducopter)'))
  assert.ok(!layeredAllow('planner').includes('Bash(pkill arducopter)'))
  assert.ok(layeredAllow('pilot').includes('Bash(pgrep*)'))
})

test('allow rules from overlapping layers appear once', () => {
  const rules = layeredAllow('pilot')
  assert.equal(rules.length, new Set(rules).size)
})

test('unknown permission sets are rejected', () => {
  const broken = { ...config, roles: { x: { model: 'haiku', permissionSets: ['fly'] } } }
  assert.throws(() => buildSettings('x', root, broken), /Unknown permission set "fly"/)
})

test('every permission set is used by some role', () => {
  const used = new Set(Object.values(config.roles).flatMap((definition) => definition.permissionSets ?? []))
  for (const name of Object.keys(config.permissionSets ?? {})) assert.ok(used.has(name), name)
})

test('the project file appends lists, merges maps and overrides plain values', () => {
  const team = {
    serviceName: 'team',
    allow: ['Bash(grep*)'],
    permissionSets: { 'gh-read': ['Bash(gh pr view*)'] },
    testCommands: ['npm test*'],
    roles: { dev: { model: 'sonnet', capabilities: ['commit'], permissionSets: ['gh-read'], env: { A: '1' } } },
  }
  const project = {
    serviceName: 'drone-team',
    allow: ['Bash(tail*)'],
    permissionSets: { 'gh-read': ['Bash(gh issue view*)'], sitl: ['Bash(pgrep*)'] },
    testCommands: ['pico test*'],
    projects: [{ name: 'p', url: 'git@github.com:o/p' }],
    roles: { dev: { model: 'haiku', permissionSets: ['sitl'], env: { B: '2' }, allow: ['Bash(make*)'] } },
  }
  const merged = mergeConfig(team, project)
  assert.equal(merged.serviceName, 'drone-team')
  assert.deepEqual(merged.allow, ['Bash(grep*)', 'Bash(tail*)'])
  assert.deepEqual(merged.permissionSets, { 'gh-read': ['Bash(gh pr view*)', 'Bash(gh issue view*)'], sitl: ['Bash(pgrep*)'] })
  assert.deepEqual(merged.testCommands, ['npm test*', 'pico test*'])
  assert.deepEqual(merged.projects, project.projects)
  assert.deepEqual(merged.roles.dev, {
    model: 'haiku',
    capabilities: ['commit'],
    permissionSets: ['gh-read', 'sitl'],
    env: { A: '1', B: '2' },
    envSets: [],
    allow: ['Bash(make*)'],
  })
})

test('team.json works on its own, without a project file', () => {
  const alone = mergeConfig(JSON.parse(fs.readFileSync(path.join(repoRoot, 'team.json'), 'utf8')))
  assert.deepEqual(alone.projects, [])
  for (const role of Object.keys(alone.roles)) assert.ok(buildSettings(role, root, alone).permissions.allow.includes('Bash(gh pr view*)'), role)
})

test('${TEAM_ROOT} expands to the team root in rules and env', () => {
  const rooted = {
    ...config,
    env: {},
    permissionSets: { tools: ['Bash(${TEAM_ROOT}/bin/tool *)'] },
    roles: { x: { model: 'haiku', permissionSets: ['tools'], allow: ['Edit(/${TEAM_ROOT}/shared/x/**)'], env: { TOOL: '${TEAM_ROOT}/bin/tool', PATH: '${TEAM_ROOT}/tools' } } },
  }
  const rules = buildSettings('x', root, rooted).permissions.allow
  assert.ok(rules.includes('Bash(/srv/team/bin/tool *)'))
  assert.ok(rules.includes('Edit(//srv/team/shared/x/**)'))
  assert.ok(!rules.some((rule) => rule.includes('TEAM_ROOT')))
  const env = agentEnv('x', root, rooted, { PATH: '/usr/bin' })
  assert.equal(env.TOOL, '/srv/team/bin/tool')
  assert.equal(env.TEAM_ROOT, root)
  assert.equal(env.PATH, '/srv/team/bin:/srv/team/tools:/usr/bin')
})

test('env layers: shared env, then env sets in order, then the role env', () => {
  const layeredEnv = {
    ...config,
    env: { PATH: '/shared/bin', LEVEL: 'shared', SHARED: '1' },
    envSets: { a: { LEVEL: 'a', A: '1', PATH: '${TEAM_ROOT}/a' }, b: { LEVEL: 'b' } },
    roles: { x: { model: 'haiku', envSets: ['a', 'b'], env: { OWN: '1' } }, y: { model: 'haiku', envSets: ['b'], env: { LEVEL: 'own' } } },
  }
  assert.deepEqual(roleEnv('x', root, layeredEnv), { PATH: '/srv/team/a:/shared/bin', LEVEL: 'b', SHARED: '1', A: '1', OWN: '1' })
  assert.deepEqual(roleEnv('y', root, layeredEnv), { PATH: '/shared/bin', LEVEL: 'own', SHARED: '1' })
})

test('unknown env sets are rejected', () => {
  const broken = { ...config, roles: { x: { model: 'haiku', envSets: ['nope'] } } }
  assert.throws(() => roleEnv('x', root, broken), /Unknown env set "nope"/)
})

test('every env set is used by some role', () => {
  const used = new Set(Object.values(config.roles).flatMap((definition) => definition.envSets ?? []))
  for (const name of Object.keys(config.envSets ?? {})) assert.ok(used.has(name), name)
})

test('the project file merges env sets and the shared env', () => {
  const merged = mergeConfig(
    { env: { A: '1' }, envSets: { s: { X: '1' } }, roles: { r: { model: 'haiku', envSets: ['s'] } } },
    { env: { B: '2' }, envSets: { s: { Y: '2' }, t: { Z: '3' } }, roles: { r: { envSets: ['t'] } } },
  )
  assert.deepEqual(merged.env, { A: '1', B: '2' })
  assert.deepEqual(merged.envSets, { s: { X: '1', Y: '2' }, t: { Z: '3' } })
  assert.deepEqual(merged.roles.r.envSets, ['s', 't'])
})

test('agents cannot edit either config file', () => {
  for (const role of Object.keys(config.roles)) {
    const { deny } = buildSettings(role, root, config).permissions
    assert.ok(deny.includes('Edit(//srv/team/team.json)') && deny.includes('Edit(//srv/team/team-project.json)'), role)
  }
})

test('projectDirName matches the Claude Code directory encoding', () => {
  assert.equal(projectDirName('/home/padcom/Downloads/padcom-dev-team'), '-home-padcom-Downloads-padcom-dev-team')
})

test('renderUnit includes the captured environment and restart policy', () => {
  const unit = renderUnit({ root, node: '/n/node', pathEnv: '/a:/b', sshAuthSock: '/s' })
  assert.match(unit, /ExecStart=\/n\/node \/srv\/team\/bin\/team run %i/)
  assert.match(unit, /Environment=PATH=\/a:\/b/)
  assert.match(unit, /Environment=SSH_AUTH_SOCK=\/s/)
  assert.match(unit, /Restart=always/)
})

test('agentEnv applies role env and keeps the inherited PATH reachable', () => {
  const roles = {
    plain: {},
    custom: { env: { PATH: '/role/bin', FOO: 'role', TEAM_ROLE: 'spoofed' } },
    talker: { channel: true },
  }
  const env = agentEnv('custom', root, { roles }, { PATH: '/inherited', FOO: 'base', KEEP: 'yes' })
  assert.equal(env.PATH, '/srv/team/bin:/role/bin:/inherited')
  assert.equal(env.FOO, 'role')
  assert.equal(env.KEEP, 'yes')
  assert.equal(env.TEAM_ROLE, 'custom')
  assert.equal(env.MCP_PROTOCOL_NEGOTIATION, undefined)
  assert.equal(agentEnv('plain', root, { roles }, { PATH: '/inherited' }).PATH, '/srv/team/bin:/inherited')
  assert.equal(agentEnv('talker', root, { roles }, { PATH: '/inherited' }).MCP_PROTOCOL_NEGOTIATION, 'legacy')
})

test('renderUnit records the display only when there is one', () => {
  const unit = renderUnit({ root, node: '/n/node', pathEnv: '/a', display: ':0', xauthority: '/h/.Xauthority' })
  assert.match(unit, /Environment=DISPLAY=:0/)
  assert.match(unit, /Environment=XAUTHORITY=\/h\/\.Xauthority/)
  assert.doesNotMatch(renderUnit({ root, node: '/n/node', pathEnv: '/a' }), /DISPLAY|XAUTHORITY/)
})

test('servicePath drops per-shell fnm directories and leads with the node directory', () => {
  const result = servicePath('/run/user/1000/fnm_multishells/1_2/bin:/usr/bin:/n/bin', '/n/bin')
  assert.equal(result, '/n/bin:/usr/bin')
})

test('formatEvent summarizes turns and ignores other events', () => {
  assert.equal(formatEvent({ type: 'system' }), null)
  assert.equal(formatEvent({ type: 'result', subtype: 'success' }), '[turn success]')
  const event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }
  assert.equal(formatEvent(event), 'tool: Bash ls')
})

const journalEntry = (fields) => ({ __REALTIME_TIMESTAMP: String(new Date(2026, 10, 9, 7, 5, 3).getTime() * 1000), ...fields })

test('formatJournalEntry prefixes agent output with its role and local time', () => {
  const entry = journalEntry({ _SYSTEMD_UNIT: 'user@1000.service', _SYSTEMD_USER_UNIT: 'padcom-team@developer.service', MESSAGE: 'tool: Bash ls' })
  assert.equal(formatJournalEntry(entry), '[developer] 07:05:03 tool: Bash ls')
})

test('formatJournalEntry attributes systemd messages to the unit they are about', () => {
  const entry = journalEntry({ _SYSTEMD_USER_UNIT: 'init.scope', USER_UNIT: 'padcom-team@qa.service', MESSAGE: 'Started agent.' })
  assert.equal(formatJournalEntry(entry), '[qa] 07:05:03 Started agent.')
})

test('formatJournalEntry decodes byte-array messages and skips unusable entries', () => {
  const unit = { _SYSTEMD_USER_UNIT: 'padcom-team@lead.service' }
  assert.equal(formatJournalEntry(journalEntry({ ...unit, MESSAGE: [104, 105] })), '[lead] 07:05:03 hi')
  assert.equal(formatJournalEntry(journalEntry({ ...unit, MESSAGE: null })), null)
  assert.equal(formatJournalEntry(journalEntry({ _SYSTEMD_USER_UNIT: 'init.scope', MESSAGE: 'x' })), null)
})

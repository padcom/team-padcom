import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildClaudeArgs, buildSettings, channelFailed, formatEvent, loadConfig, mergeBlockers, projectDirName, renderUnit, servicePath, teamRepoOfPrUrl } from '../lib/team.mjs'

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

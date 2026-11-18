// Secrets: test accounts kept outside the repo, read by name, and kept out of enki's logs and files.
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { redact, secretsIn } from '../src/secrets.mjs'
import { makeProject } from './helpers/harness.mjs'

const decision = result => result.json?.hookSpecificOutput?.permissionDecision ?? null
const VALUE = 'Hunter-22!pw'

test('redaction hides each value as written and as JSON writes it, and a set command’s value', () => {
  const secrets = { 'qa-password': 'a"b\\c-pass' }
  assert.equal(redact('login a"b\\c-pass now', secrets), 'login [secret:qa-password] now')
  assert.equal(redact(JSON.stringify({ target: 'a"b\\c-pass' }), secrets), '{"target":"[secret:qa-password]"}')
  assert.equal(redact('enki secret set qa-password s3cret-x; enki status', {}), 'enki secret set qa-password [hidden]; enki status')
  assert.deepEqual(secretsIn('nothing here', secrets), [])
})

test('a secret is stored outside the repo for the user only, read by name, and set only by the orchestrator', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const set = project.enki(['secret', 'set', 'qa-password', VALUE])
  assert.equal(set.code, 0, set.err)
  assert.doesNotMatch(set.out, new RegExp(VALUE))
  const id = JSON.parse(readFileSync(join(project.root, '.enki', 'config.json'), 'utf8')).id
  const file = join(project.env.ENKI_HOME, 'secrets', `${id}.json`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(project.enki(['secret', 'list']).out.trim(), 'qa-password')
  assert.equal(project.enki(['secret', 'get', 'qa-password'], project.asWorker('qa')).out, `${VALUE}\n`, 'an agent reads it by name')
  assert.notEqual(project.enki(['secret', 'set', 'other', 'value-1'], project.asWorker('qa')).code, 0, 'an agent never sets one')
  assert.notEqual(project.enki(['secret', 'set', 'Bad Name', 'value-1']).code, 0)
})

test('a secret never reaches the activity log, the events, or a file', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  project.enki(['secret', 'set', 'qa-password', VALUE])
  project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: `curl -d "password=${VALUE}" http://localhost:4400/api/auth/signin` } })
  const brief = join(project.taskDir('demo'), 'briefs', 'qa-1.md')
  const write = project.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: brief, content: `Sign in with ${VALUE}` } })
  assert.equal(decision(write), 'deny')
  assert.match(write.json.hookSpecificOutput.permissionDecisionReason, /secret qa-password.*enki secret get qa-password/)
  const edit = project.hook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: brief, old_string: 'x', new_string: VALUE } }, project.asWorker('qa'))
  assert.equal(decision(edit), 'deny')
  for (const file of ['activity.jsonl', 'events.jsonl']) {
    const text = readFileSync(join(project.taskDir('demo'), file), 'utf8')
    assert.doesNotMatch(text, new RegExp(VALUE.replace(/[!-]/g, '\\$&')), file)
  }
  assert.match(readFileSync(join(project.taskDir('demo'), 'activity.jsonl'), 'utf8'), /\[secret:qa-password\]/)
})

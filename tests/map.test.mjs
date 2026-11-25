// The codebase map's checks: what blocks a task's end, and what is only a warning.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkMap, mapGraph, mapIsEmpty, STUB_ROOT } from '../src/map.mjs'

/** A memory folder with a map made of `files`, and a code folder with `code` in it. */
function setup(files, code = ['src/cart.js', 'src/game/']) {
  const base = mkdtempSync(join(tmpdir(), 'enki-map-'))
  const dir = join(base, 'memory', 'map')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  for (const path of code) {
    if (path.endsWith('/')) mkdirSync(join(base, 'code', path), { recursive: true })
    else {
      mkdirSync(dirname(join(base, 'code', path)), { recursive: true })
      writeFileSync(join(base, 'code', path), 'x\n')
    }
  }
  return { memory: join(base, 'memory'), dir, codeDir: join(base, 'code') }
}

const area = (title, files, areas = '') => `# ${title}\n\nWhat it is.\n\nFiles: ${files}\n\n## How it works\n\nIt works.\n\n## Gotchas\n\n- None known.\n${areas ? `\n## Areas\n\n${areas}\n` : ''}`

const GOOD = {
  'README.md': area('web', '`src/`', '- [shop](shop/README.md): products and cart\n- [game](game.md): the glass game'),
  'shop/README.md': area('Shop', 'src/cart.js', '- [cart](cart.md): the cart, see [the game](../game.md)'),
  'shop/cart.md': area('Cart', 'src/cart.js'),
  'game.md': area('Game', 'src/game/'),
}

test('a nested map that holds together has no errors and no warnings', () => {
  const { dir, codeDir } = setup({ ...GOOD, 'shop/cart.md': `${area('Cart', 'src/cart.js')}\nSee [the docs](https://example.com) and [top](#gotchas).\n` })
  assert.deepEqual(checkMap({ dir, codeDir }), { errors: [], warnings: [] })
})

test('errors: a missing root, a folder without a README, a link that goes nowhere, a file its parent doesn\'t list', () => {
  assert.match(checkMap({ dir: setup({ 'game.md': 'x' }).dir }).errors[0], /map\/README\.md is missing/)
  const { dir } = setup({
    ...GOOD,
    'game.md': area('Game', 'src/game/', '- [score](game/score.md): scoring'),
    'game/score.md': area('Score', 'src/game/'),
    'shop/stray.md': area('Stray', 'src/cart.js'),
    'shop/cart.md': `${area('Cart', 'src/cart.js')}\nSee [gone](../gone.md).\n`,
  })
  const { errors } = checkMap({ dir })
  assert.ok(errors.some(error => /map\/game\/ has no README\.md/.test(error)), errors.join('\n'))
  assert.ok(errors.some(error => /map\/shop\/cart\.md: the link \.\.\/gone\.md goes nowhere/.test(error)), errors.join('\n'))
  assert.ok(errors.some(error => /map\/shop\/stray\.md isn't in map\/shop\/README\.md's Areas list/.test(error)), errors.join('\n'))
  // A link outside the Areas list doesn't count as listing a child.
  const unlisted = setup({ ...GOOD, 'README.md': area('web', 'src/', '- [game](game.md): the game').replace('What it is.', 'What it is. See [shop](shop/README.md).') })
  assert.ok(checkMap({ dir: unlisted.dir }).errors.some(error => /map\/shop\/README\.md isn't in map\/README\.md's Areas list/.test(error)))
})

test('warnings: sizes, paths in Files: that no longer exist, links to other repos', () => {
  const { dir, codeDir } = setup({
    ...GOOD,
    'README.md': `${GOOD['README.md']}\n${'r'.repeat(3200)}\nThe API: [tokens](melda-server:api/livekit.md), [nowhere](melda-server:api/gone.md), [who](nobody:x.md).\n`,
    'game.md': `${area('Game', 'src/game/, `src/old.js`, src/*.test.js')}\n${'g'.repeat(4200)}\n`,
  })
  const resolveRepo = (name, path) => (name === 'melda-server' ? path === 'api/livekit.md' : null)
  const { errors, warnings } = checkMap({ dir, codeDir, resolveRepo })
  assert.deepEqual(errors, [])
  assert.ok(warnings.some(warning => /map\/README\.md is .* KB, over 3 KB/.test(warning)), warnings.join('\n'))
  assert.ok(warnings.some(warning => /map\/game\.md is .* KB, over 4 KB/.test(warning)), warnings.join('\n'))
  assert.ok(warnings.some(warning => /map\/game\.md: src\/old\.js \(in Files:\) doesn't exist/.test(warning)), warnings.join('\n'))
  assert.ok(!warnings.some(warning => /test\.js/.test(warning)), 'globs are skipped')
  assert.ok(warnings.some(warning => /melda-server:api\/gone\.md isn't in melda-server's map yet/.test(warning)), warnings.join('\n'))
  assert.ok(!warnings.some(warning => /livekit/.test(warning)), 'a link that resolves is fine')
  assert.ok(warnings.some(warning => /nobody:x\.md names a repo enki doesn't know/.test(warning)), warnings.join('\n'))
})

test('the stub root is a map with no areas yet', () => {
  const { memory, dir } = setup({ 'README.md': STUB_ROOT('web') })
  assert.equal(mapIsEmpty(memory), true)
  assert.deepEqual(checkMap({ dir }).errors, [])
  assert.equal(mapIsEmpty(setup(GOOD).memory), false)
})

test('the graph: a node per file, tree lines to parents, link lines across files and repos, and a node for a repo with no map', () => {
  const web = { ...GOOD, 'shop/cart.md': `${area('Cart', 'src/cart.js')}\nCalls [the API](api:README.md) and [gone](../gone.md).\n`, 'shop/stray.md': area('Stray', 'x') }
  const { nodes, edges } = mapGraph('shop', [{ name: 'web', files: web }, { name: 'api', files: { 'README.md': '# api\n' } }, { name: 'docs', files: {} }])
  const byId = Object.fromEntries(nodes.map(node => [node.id, node]))
  assert.deepEqual(Object.keys(byId).sort(), ['@project', 'api:README.md', 'docs:', 'web:README.md', 'web:game.md', 'web:shop/README.md', 'web:shop/cart.md', 'web:shop/stray.md'])
  assert.equal(byId['web:README.md'].title, 'web', 'a root is named after its repo')
  assert.equal(byId['web:shop/cart.md'].title, 'Cart')
  assert.equal(byId['web:shop/cart.md'].description, 'the cart, see [the game](../game.md)')
  assert.deepEqual(byId['web:shop/cart.md'].files, ['src/cart.js'])
  assert.equal(byId['web:shop/cart.md'].depth, 3)
  assert.equal(byId['web:shop/stray.md'].listed, false)
  assert.equal(byId['docs:'].kind, 'empty')
  assert.deepEqual(byId['web:shop/cart.md'].links, { 'api:README.md': 'api:README.md' }, 'links that go nowhere are left out')
  const has = (from, to, kind) => edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind)
  assert.ok(has('@project', 'web:README.md', 'tree'))
  assert.ok(has('@project', 'docs:', 'tree'))
  assert.ok(has('web:shop/README.md', 'web:shop/cart.md', 'tree'))
  assert.ok(has('web:shop/README.md', 'web:shop/stray.md', 'tree'), 'an unlisted file still hangs from its folder')
  assert.ok(has('web:shop/cart.md', 'api:README.md', 'link'))
  assert.ok(has('web:shop/README.md', 'web:game.md', 'link'))
  assert.equal(edges.filter(edge => [edge.from, edge.to].sort().join() === 'web:shop/README.md,web:shop/cart.md').length, 1, 'a parent that also links its child has one line')
  assert.equal(mapGraph('one', [{ name: 'web', files: GOOD }]).nodes.some(node => node.kind === 'project'), false, 'one repo needs no project node')
})

// grep's pattern is an RE2 one (`re2js`), not a JavaScript `RegExp`: the search runs over files a
// user did not write, so it may not backtrack. These tests pin both halves of that -- the matches and
// the shape of the answer are what `RegExp` gave, and a pattern that would hang a backtracking engine
// finishes in milliseconds instead.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { shell } from './support.mjs';

/** A throwaway workspace plus a node pointed at it. */
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'shell-grep-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, node: shell(t, root) };
}

/** How long `fn` took, in milliseconds. */
async function timed(fn) {
  const started = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

test('a plain regex still matches line by line, in path:line: text form', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', {
    path: 'src/app.ts',
    content: 'const one = 1;\nconst two = 22;\nexport { one };\n',
  });
  await node.handle('write', { path: 'README.md', content: 'one among 22 words\n' });

  assert.equal(
    await node.handle('grep', { pattern: '\\bconst\\s+\\w+\\s+=' }),
    'src/app.ts:1: const one = 1;\nsrc/app.ts:2: const two = 22;',
  );
  // A pattern that matches nowhere is the same answer it was before.
  assert.equal(await node.handle('grep', { pattern: 'nothing-here' }), '(no matches)');
  // Alternation, anchors, groups and escapes reach RE2 the same way they reached `RegExp`.
  assert.equal(
    await node.handle('grep', { pattern: '^(const|export) .*;$' }),
    'src/app.ts:1: const one = 1;\nsrc/app.ts:2: const two = 22;\nsrc/app.ts:3: export { one };',
  );
  assert.equal(
    await node.handle('grep', { pattern: '\\d{2}\\b' }),
    'README.md:1: one among 22 words\nsrc/app.ts:2: const two = 22;',
  );
});

test('matching is case-sensitive by default, and (?i) turns that off', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'a.txt', content: 'Alpha\nalpha\nALPHA\n' });

  assert.equal(await node.handle('grep', { pattern: 'alpha' }), 'a.txt:2: alpha');
  assert.equal(
    await node.handle('grep', { pattern: '(?i)alpha' }),
    'a.txt:1: Alpha\na.txt:2: alpha\na.txt:3: ALPHA',
  );
});

test('glob still narrows the walk and MAX_MATCHES still caps the answer', async (t) => {
  const { node } = await setup(t);
  const many = Array.from({ length: 250 }, (_unused, index) => `needle ${index}`).join('\n');
  await node.handle('write', { path: 'many.txt', content: many });
  await node.handle('write', { path: 'deep/one.md', content: 'needle here\n' });

  assert.equal(
    await node.handle('grep', { pattern: 'needle', glob: '**/*.md' }),
    'deep/one.md:1: needle here',
  );

  const rows = (await node.handle('grep', { pattern: 'needle' })).split('\n');
  assert.equal(rows.length, 200);
  assert.equal(rows[0], 'many.txt:1: needle 0');
  assert.equal(rows[199], 'many.txt:200: needle 199');
});

test('a binary file and an oversized file are still skipped', async (t) => {
  const { root, node } = await setup(t);
  await node.handle('write', { path: 'small.txt', content: 'needle\n' });
  // A NUL byte marks a binary file; past MAX_GREP_BYTES a file is not a source file worth scanning.
  await writeFile(
    join(root, 'blob.bin'),
    Buffer.concat([Buffer.from('needle'), Buffer.from([0]), Buffer.from('needle\n')]),
  );
  await writeFile(join(root, 'huge.txt'), `needle\n${'x'.repeat(1024 * 1024 + 1)}\n`);

  assert.equal(await node.handle('grep', { pattern: 'needle' }), 'small.txt:1: needle');
});

test('an unbalanced pattern is an invalid regular expression, not a crash', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'a.txt', content: 'alpha\n' });

  const broken = {
    '(': /missing closing \)/,
    '[a': /missing closing \]/,
    'a{2,1}': /invalid repeat count/,
    '\\': /trailing backslash/,
    '*a': /missing argument to repetition operator/,
  };
  for (const [pattern, why] of Object.entries(broken)) {
    await assert.rejects(node.handle('grep', { pattern }), (error) => {
      assert.match(error.message, /^invalid regular expression: error parsing regexp: /, pattern);
      assert.match(error.message, why, pattern);
      return true;
    });
  }
  // The node is still there, and still searching, after each refusal.
  assert.equal(await node.handle('grep', { pattern: 'alpha' }), 'a.txt:1: alpha');
});

test('RE2-only limits are reported by name: backreferences, lookaround, atomic groups', async (t) => {
  const { node } = await setup(t);
  await node.handle('write', { path: 'a.txt', content: 'alpha beta\n' });

  const refused = {
    '(a)\\1': /invalid escape sequence/,
    'alpha(?= beta)': /invalid or unsupported Perl syntax/,
    'alpha(?! beta)': /invalid or unsupported Perl syntax/,
    '(?<=alpha) beta': /invalid named capture/,
    '(?<!alpha) beta': /invalid named capture/,
    '(?>alpha)': /invalid or unsupported Perl syntax/,
  };
  const { ms } = await timed(async () => {
    for (const [pattern, why] of Object.entries(refused)) {
      await assert.rejects(node.handle('grep', { pattern }), (error) => {
        assert.match(error.message, /^invalid regular expression: /, pattern);
        assert.match(error.message, why, pattern);
        return true;
      });
    }
  });
  assert.ok(ms < 2000, `${ms}ms for six refusals`);
});

test('a catastrophic pattern finishes at once instead of hanging', async (t) => {
  const { node } = await setup(t);
  // The line a backtracking engine dies on: 50 000 `a`s and no `!`, under `(a+)+$`.
  const line = 'a'.repeat(50_000);
  await node.handle('write', { path: 'evil.txt', content: `${line}\nend\n` });

  for (const pattern of ['(a+)+$', '(a|aa)+$', '(a*)*b']) {
    const { value, ms } = await timed(() => node.handle('grep', { pattern }));
    assert.ok(ms < 2000, `${pattern} took ${ms}ms on a line of 50 000 a's`);
    if (pattern === '(a*)*b') assert.equal(value, '(no matches)');
    else assert.equal(value, `evil.txt:1: ${line}`);
  }
});

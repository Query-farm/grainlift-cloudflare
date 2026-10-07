// Exercise the real Durable Object SQLite implementation, not a storage mock.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const { outputFiles } = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
      import { BlogDemo } from './src/blog-demo';
      export class TestDemo extends BlogDemo {
        async expire() {
          await this.ctx.storage.put('blog-demo-next-reset', 0);
          await this.alarm();
        }
        async repeatAlarm() { await this.alarm(); }
        async deadline() { return this.ctx.storage.getAlarm(); }
      }
      export default {
        async fetch(request, env) {
          const object = env.DEMO.getByName('playground');
          const { action, sql } = await request.json();
          if (action === 'expire') { await object.expire(); return Response.json(true); }
          if (action === 'alarm') { await object.repeatAlarm(); return Response.json(true); }
          if (action === 'deadline') return Response.json(await object.deadline());
          return Response.json(await object.grainliftRows(sql, []));
        }
      };
    `,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false,
});
const persist = await mkdtemp(join(tmpdir(), 'grainlift-blog-demo-'));
const options = convertV4MiniflareOptions({
  name: 'blog-demo-test', modules: true, script: outputFiles[0].text, compatibilityDate: '2025-09-01',
  durableObjects: { DEMO: { className: 'TestDemo', useSQLite: true } },
});
options.resourcePersistencePath = persist;
let mf = new Miniflare(options);
async function call(action, sql) {
  const response = await mf.dispatchFetch('http://demo.test', {
    method: 'POST', body: JSON.stringify({ action, sql }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const query = sql => call('query', sql);
try {
  assert.deepEqual((await query('SELECT count(*) FROM products')).rows, [[6]]);
  assert.deepEqual((await query('SELECT count(*) FROM orders')).rows, [[12]]);
  const deadline = await call('deadline');
  assert(deadline > Date.now());
  assert(deadline <= Date.now() + 4 * 60 * 60 * 1000);
  assert.equal(deadline % (4 * 60 * 60 * 1000), 0);
  assert.equal((await query('SELECT next_reset_at FROM demo_info')).rows[0][0], new Date(deadline).toISOString());
  await query("INSERT INTO visitor_notes (id, note) VALUES ('test', 'Keep me until reset')");
  await query('CREATE TABLE visitor_created (n INTEGER)');
  await query("UPDATE products SET name = 'Changed by visitor' WHERE id = 1");
  await call('alarm');
  assert.deepEqual((await query('SELECT count(*) FROM visitor_notes')).rows, [[1]], 'early/repeated alarms preserve this cycle');
  await mf.dispose();
  mf = new Miniflare(options);
  assert.deepEqual((await query('SELECT count(*) FROM visitor_notes')).rows, [[1]], 'eviction preserves writes');
  assert.equal(await call('deadline'), deadline, 'eviction does not postpone reset');
  await call('expire');
  assert.deepEqual((await query('SELECT count(*) FROM visitor_notes')).rows, [[0]]);
  assert.deepEqual((await query("SELECT count(*) FROM sqlite_master WHERE name = 'visitor_created'")).rows, [[0]]);
  assert.deepEqual((await query('SELECT name FROM products WHERE id = 1')).rows, [['House blend']]);
  await query("INSERT INTO visitor_notes (id, note) VALUES ('after', 'After reset')");
  await call('alarm');
  assert.deepEqual((await query('SELECT count(*) FROM visitor_notes')).rows, [[1]], 'duplicate delivery does not reset twice');
  console.log('PASS: seed, deadline, persistence, full cleanup, reseed, repeated alarm');
} finally {
  await mf.dispose();
  await rm(persist, { recursive: true, force: true });
}

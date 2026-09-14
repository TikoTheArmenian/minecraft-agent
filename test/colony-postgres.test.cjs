/** Real SQL integration test. Uses a disposable database in an explicitly named test container. */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const container = process.env.COLONY_TEST_CONTAINER
function psql(database, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-Atq',
    ])
    let out = '',
      err = ''
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', reject)
    child.on('close', (code) =>
      code ? reject(new Error(err)) : resolve(out.trim()),
    )
    child.stdin.end(sql)
  })
}
const quote = (value) =>
  "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb"
test(
  'Postgres migration, two-worker exclusion, reservations and uncertain operations',
  { skip: !container },
  async (t) => {
    const database = 'colony_test_' + randomUUID().replaceAll('-', '')
    await psql('postgres', `create database ${database};`)
    t.after(() => psql('postgres', `drop database ${database} with (force);`))
    await psql(
      database,
      `do $$ begin create role anon; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role; exception when duplicate_object then null; end $$;`,
    )
    await psql(
      database,
      fs.readFileSync(
        require('node:path').join(
          __dirname,
          '../supabase/migrations/202609140001_colony.sql',
        ),
        'utf8',
      ),
    )
    await psql(
      database,
      fs.readFileSync(
        require('node:path').join(
          __dirname,
          '../supabase/migrations/202609140002_world_registry.sql',
        ),
        'utf8',
      ),
    )
    await psql(database, fs.readFileSync(require('node:path').join(__dirname,'../supabase/migrations/202609140004_storage_hub.sql'),'utf8'))
    await t.test('hub is dimension scoped and backend only',async()=>{
      const world=randomUUID()
      const rpc=(action,dimension,position)=>`select public.colony_hub_rpc('${action}',${quote({world,dimension,position})});`
      await psql(database,rpc('hub_set','overworld',{x:10,y:64,z:20}))
      assert.deepEqual(JSON.parse(await psql(database,rpc('hub_get','overworld'))).position,{x:10,y:64,z:20})
      assert.equal(JSON.parse(await psql(database,rpc('hub_get','nether'))).position,null)
      await assert.rejects(psql(database,`set role anon;${rpc('hub_set','overworld',{x:0,y:64,z:0})}`),/permission denied/)
      await assert.rejects(psql(database,rpc('hub_set','overworld',{x:0,y:999,z:0})),/Invalid hub/)
    })
    await t.test(
      'world registration converges across concurrent bots and ignores empty legacy placeholders',
      async () => {
        const resolve = (label) =>
          psql(
            database,
            `select public.colony_resolve_world('${label}','11111111-1111-4111-8111-111111111111');`,
          )
        const [a, b] = await Promise.all([
          resolve('Shared world'),
          resolve('Shared world'),
        ])
        assert.equal(a, b)
        assert.notEqual(a, '11111111-1111-4111-8111-111111111111')
        assert.notEqual(await resolve('Other world'), a)
        await assert.rejects(
          psql(
            database,
            "set role anon; select public.colony_resolve_world('Shared world');",
          ),
          /permission denied/,
        )
      },
    )
    await psql(
      database,
      fs.readFileSync(
        require('node:path').join(
          __dirname,
          '../supabase/migrations/202609140003_reconcile_storage.sql',
        ),
        'utf8',
      ),
    )
    const world = randomUUID(),
      a = { world, dimension: 'overworld', session: randomUUID(), bot: 'Marc' },
      b = { ...a, session: randomUUID(), bot: 'Jerry' }
    const call = (actor, action, data = {}) =>
      psql(
        database,
        `select public.colony_rpc('${action}',${quote({ ...actor, ...data })});`,
      ).then(JSON.parse)
    const chest = {
      container: '0,64,0',
      position: { x: 0, y: 64, z: 0 },
      blocks: [{ x: 0, y: 64, z: 0 }],
      capacity: 27,
    }
    await call(a, 'register', chest)
    let token = randomUUID()
    await t.test(
      'only one process can acquire a chest; other dimensions remain independent',
      async () => {
        const results = await Promise.allSettled([
          call(a, 'acquire', { ...chest, token }),
          call(b, 'acquire', { ...chest, token: randomUUID() }),
        ])
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
        // Whichever contender won is cleaned up using its actual lease, without guessing.
        const lease = JSON.parse(
          await psql(database, `select row_to_json(l) from colony.leases l;`),
        )
        await call(lease.session === a.session ? a : b, 'release', {
          ...chest,
          token: lease.token,
        })
        const other = { ...a, dimension: 'the_nether' }
        await call(other, 'register', chest)
        await call(other, 'acquire', { ...chest, token: randomUUID() })
        await call(a, 'acquire', { ...chest, token })
      },
    )
    await call(a, 'manage', { ...chest, token, category: 'wood' })
    await call(a, 'snapshot', {
      ...chest,
      token,
      slots: [{ name: 'oak_log', fingerprint: 'wood', count: 10, slot: 0 }],
    })
    await call(a, 'release', { ...chest, token })
    const job1 = randomUUID(),
      job2 = randomUUID()
    for (const [actor, job] of [
      [a, job1],
      [b, job2],
    ]) {
      await call(actor, 'enqueue', { job, item: 'chest', quantity: 1 })
      await call(actor, 'claim_job', { job })
    }
    await t.test(
      'reservations atomically reject oversubscription and cannot be stolen',
      async () => {
        await call(a, 'reserve', {
          job: job1,
          items: [
            { container: chest.container, fingerprint: 'wood', quantity: 7 },
          ],
        })
        await assert.rejects(
          call(b, 'reserve', {
            job: job2,
            items: [
              { container: chest.container, fingerprint: 'wood', quantity: 7 },
            ],
          }),
          /reserved/,
        )
        await assert.rejects(
          call(b, 'job_status', { job: job1, state: 'complete' }),
          /ownership/,
        )
        const data = await call(a, 'list')
        assert.equal(data.reservations.length, 1)
      },
    )
    await t.test(
      'a transfer snapshot commits once; uncertain transfers quarantine even expired leases',
      async () => {
        token = randomUUID()
        await call(a, 'acquire', { ...chest, token })
        const operation = randomUUID()
        await call(a, 'begin', {
          ...chest,
          token,
          operation,
          job: job1,
          kind: 'withdraw',
          detail: { fingerprint: 'wood', count: 2 },
        })
        await call(a, 'finish', {
          ...chest,
          token,
          operation,
          slots: [{ name: 'oak_log', fingerprint: 'wood', count: 8, slot: 0 }],
        })
        await assert.rejects(
          call(a, 'finish', { ...chest, token, operation, slots: [] }),
          /ownership/,
        )
        const data = await call(a, 'list')
        assert.equal(data.containers[0].slots[0].count, 8)
        assert.equal(data.reservations[0].quantity, 5)
        await call(a, 'begin', {
          ...chest,
          token,
          operation: randomUUID(),
          job: job1,
          kind: 'withdraw',
          detail: { fingerprint: 'wood', count: 1 },
        })
        await psql(
          database,
          `update colony.leases set expires_at=now()-interval '1 second' where world='${world}' and dimension='overworld';`,
        )
        await assert.rejects(
          call(b, 'acquire', { ...chest, token: randomUUID() }),
          /uncertain/,
        )
      },
    )
    await t.test(
      'expired job becomes blocked and releases reservations, never requeued',
      async () => {
        await psql(
          database,
          `update colony.jobs set updated_at=now()-interval '6 minutes' where id='${job1}';`,
        )
        const data = await call(a, 'list')
        assert.equal(data.jobs.find((j) => j.id === job1).state, 'blocked')
        assert.equal(data.reservations.length, 0)
        assert.equal(await call(b, 'claim_job', { job: job1 }), null)
        assert.equal(data.uncertain.length, 1)
      },
    )
    await t.test(
      'anonymous and browser users cannot call the mutation RPC',
      async () => {
        await assert.rejects(
          psql(
            database,
            `set role anon; select public.colony_rpc('list',${quote(a)});`,
          ),
          /permission denied/,
        )
        await assert.rejects(
          psql(
            database,
            `set role authenticated; select * from colony.containers;`,
          ),
          /permission denied/,
        )
      },
    )
    await t.test(
      'explicit reconciliation requires a retired worker and preserves historical operations',
      async () => {
        const token = randomUUID()
        const repair = (action, extra = {}) =>
          psql(
            database,
            `select public.colony_reconcile_rpc('${action}',${quote({ ...b, ...chest, token, ...extra })});`,
          )
        await assert.rejects(repair('reconcile_acquire'), /recently active/)
        await psql(
          database,
          `update colony.sessions set seen_at=now()-interval '2 minutes' where session='${a.session}';`,
        )
        await repair('reconcile_acquire')
        await assert.rejects(
          call(a, 'acquire', { ...chest, token: randomUUID() }),
          /uncertain/,
        )
        await repair('reconcile_finish', {
          slots: [{ name: 'oak_log', fingerprint: 'wood', count: 7, slot: 0 }],
          playerInventory: [],
        })
        await call(b, 'release', { ...chest, token })
        const data = await call(b, 'list')
        assert.equal(data.uncertain.length, 0)
        assert.equal(data.containers[0].slots[0].count, 7)
        const count = await psql(
          database,
          "select count(*) from colony.operations where state='reconciled';",
        )
        assert.equal(count, '1')
        await assert.rejects(
          psql(
            database,
            `set role anon; select public.colony_reconcile_rpc('reconcile_acquire',${quote({ ...b, ...chest, token })});`,
          ),
          /permission denied/,
        )
      },
    )
    await t.test(
      'a separate world cannot see stock or queued jobs',
      async () => {
        const data = await call({ ...a, world: randomUUID() }, 'list')
        assert.equal(data.containers.length, 0)
        assert.equal(data.jobs.length, 0)
      },
    )
  },
)

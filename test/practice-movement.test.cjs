const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fixture, Vec3 } = require('./helpers/survival-fixture.cjs')
const { PracticeMovement } = require('../src/skills/practice-movement.cjs')
const { parse } = require('../src/agents/agent.cjs')
function setup() { const h = fixture(); return {...h, work: new PracticeMovement(h.agent,1)} }

test('practice movement aliases dispatch the continuous skill', () => {
  for (const text of ['practice-movement','practice movement','start practice movement'])
    assert.equal(parse(text).type,'practiceMovement')
  const h=setup()
  assert.equal(h.work.deadline,Infinity)
  assert.equal(h.work.task.continuous,true)
})
test('finds nearest dry or wet sponge, excluding markers beyond scan range', () => {
  const h=setup()
  h.set('sponge',new Vec3(10,64,0)); h.set('wet_sponge',new Vec3(4,64,0))
  assert.deepEqual(h.work.nearest(),new Vec3(4,64,0))
  h.blocks.clear();h.set('sponge',new Vec3(65,64,0))
  assert.equal(h.work.nearest(),null)
})
test('waits for a marker, reaches beside it without mining, and stays until Stop', async () => {
  const h=setup(),p=new Vec3(5,64,0)
  let scans=0,routes=0
  h.work.travel=async goal=>{
    routes++;assert.equal(goal.isEnd(p.offset(-1,0,0)),true)
    h.bot.entity.position=p.offset(-1,0,0)
  }
  h.work.pause=async()=>{
    if (++scans===1) h.set('sponge',p)
    if (scans===3) h.work.cancel()
    h.work.check()
  }
  await h.work.run()
  assert.equal(routes,1)
  assert.equal(h.work.task.status,'cancelled')
  assert.equal(h.dug.length,0);assert.equal(h.placed.length,0)
})
test('blocked routes retry rather than ending the continuous scan', async () => {
  const h=setup();h.set('sponge',new Vec3(5,64,0));let attempts=0
  h.work.travel=async()=>{attempts++;throw new Error('No route')}
  h.work.pause=async ms=>{assert.equal(ms,3000);if(attempts===2)h.work.cancel();h.work.check()}
  await h.work.run()
  assert.equal(attempts,2);assert.equal(h.work.task.status,'cancelled')
})
test('removing the target interrupts travel and scans again', {timeout:4000}, async () => {
  const h=setup(),p=new Vec3(5,64,0);h.set('sponge',p)
  let interrupted=false
  h.work.travel=async()=>new Promise((resolve,reject)=>{
    h.set('air',p)
    h.bot.pathfinder.setGoal=()=>{interrupted=true;reject(new Error('Goal changed'))}
  })
  h.work.pause=async()=>{h.work.cancel();h.work.check()}
  await h.work.run()
  assert.equal(interrupted,true);assert.equal(h.work.task.status,'cancelled')
})
test('a requested handoff settles the route and records actual arrival before switching', async () => {
  const h = setup(), target = new Vec3(5, 64, 0)
  h.set('sponge', target)
  let routes = 0
  h.work.travel = async () => { routes++; h.work.requestHandoff(); h.bot.entity.position = target.offset(-1, 0, 0) }
  h.work.pause = async () => h.work.check()
  await assert.rejects(h.work.run(), { code: 'HANDOFF' })
  assert.equal(routes, 1)
  assert.equal(h.work.task.reasonCode, 'HANDOFF')
  assert.equal(h.work.task.checkpoint.data.phase, 'route-settled')
  assert.equal(h.work.effects[0].kind, 'arrival')
  assert.equal(h.work.targetChanged, false)
})

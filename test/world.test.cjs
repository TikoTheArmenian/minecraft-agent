const {test}=require('node:test')
const assert=require('node:assert/strict')
const {fixture,Vec3}=require('./helpers/survival-fixture.cjs')
const {buildMap,MapStore}=require('../src/world/observations.cjs')

test('map follows the nearby player and uses actual block names and heights',()=>{
  const f=fixture();f.bot.players.Alex={username:'Alex',entity:{position:new Vec3(12,65,4)}}
  f.set('iron_ore',new Vec3(12,65,4))
  const m=buildMap(f.bot);const center=m.cells[16*m.size+16]
  assert.equal(m.focus,'Alex');assert.equal(m.palette[center.block].name,'iron_ore');assert.equal(center.y,65);assert.equal(m.cells.length,1089)
  assert.equal(buildMap(f.bot,{focus:'bot'}).center.x,0)
})
test('unloaded columns stay unknown instead of showing invented ground',()=>{
  const f=fixture();f.bot.blockAt=()=>null
  const m=buildMap(f.bot);assert.ok(m.cells.every(c=>c.unknown && c.y===null))
})
test('height controls show a lower layer without changing the player',()=>{
  const f=fixture();f.set('oak_log',new Vec3(0,66,0));const hi=buildMap(f.bot),lo=buildMap(f.bot,{offset:-4})
  const i=16*hi.size+16
  assert.equal(hi.palette[hi.cells[i].block].name,'oak_log');assert.equal(lo.palette[lo.cells[i].block].name,'dirt')
  assert.equal(f.bot.entity.position.y,64)
})
test('map selection resolves a bounded area on the server with no typed coordinates',()=>{
  const f=fixture();f.agent.state.task=null;const store=new MapStore(f.agent),m=store.snapshot({focus:'bot',offset:0})
  store.action({snapshot:m.id,from:16*m.size+16,to:17*m.size+17,depth:2,action:'mine'})
  assert.deepEqual({...f.commands[0].min},{x:0,y:62,z:0});assert.deepEqual({...f.commands[0].max},{x:1,y:63,z:1});assert.equal(f.commands[0].volume,8)
})
test('map actions reject expiry, session switches and terrain that changed',()=>{
  const f=fixture();f.agent.state.task=null;const store=new MapStore(f.agent),m=store.snapshot({focus:'bot',offset:0}),body={snapshot:m.id,from:544,action:'mine'}
  f.agent.epoch++;assert.throws(()=>store.action(body),/out of date/);f.agent.epoch--
  m.at-=31000;assert.throws(()=>store.action(body),/out of date/);m.at+=31000
  f.set('water',new Vec3(0,63,0));assert.throws(()=>store.action(body),/changed/)
  assert.deepEqual(f.commands,[])
})
test('map rejects forged indices, excessive volumes, unknown cells and work conflicts',()=>{
  const f=fixture();f.agent.state.task=null;const store=new MapStore(f.agent),m=store.snapshot({focus:'bot',offset:0}),body={snapshot:m.id,from:0,action:'mine'}
  assert.throws(()=>store.action({...body,from:-1}),/Select/)
  assert.throws(()=>store.action({...body,to:1088,depth:4}),/512/)
  m.cells[0].y=null;assert.throws(()=>store.action(body),/unknown/)
  f.agent.workActive=true;assert.throws(()=>store.action(body),/Stop/)
})

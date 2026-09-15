const test=require('node:test'),assert=require('node:assert/strict')
const {fixture,Vec3}=require('./helpers/survival-fixture.cjs')
const {getTorches,lightArea,charcoal}=require('../src/skills/torches.cjs')
const {parse}=require('../src/agents/agent.cjs')
test('get torches command is available and existing torch stock is reused',async()=>{const f=fixture();f.add('torch',16);await getTorches(f.work,16);assert.equal(f.crafted.length,0);assert.equal(parse('get torches').type,'torches')})
test('torch recipes use coal and sticks with confirmed output',async()=>{const f=fixture();f.add('coal',2);f.add('stick',2);await getTorches(f.work,8);assert.equal(f.work.count('torch'),8);assert.equal(f.work.count('coal'),0)})
test('charcoal is accepted for torch crafting',async()=>{const f=fixture();f.add('charcoal',2);f.add('stick',2);await getTorches(f.work,8);assert.equal(f.work.count('torch'),8)})
test('farm lighting preserves crops and avoids repeatedly placing nearby torches',async()=>{
 const f=fixture();f.add('torch',8);f.set('wheat',new Vec3(1,64,1),2);f.set('farmland',new Vec3(1,63,1));f.set('dirt',new Vec3(3,63,1));f.set('dirt',new Vec3(4,63,1))
 await lightArea(f.work);await lightArea(f.work);assert.equal(f.placed.filter(n=>n==='torch').length,1);assert.equal(f.bot.blockAt(new Vec3(1,64,1)).name,'wheat')
})
test('charcoal smelting loads materials, verifies output and closes furnace',async()=>{
 const f=fixture();f.set('furnace',new Vec3(1,64,0));f.add('oak_log',3);f.add('oak_planks',2);let input=false,fuel=false,closed=false
 f.bot.openFurnace=async()=>({inputItem:()=>null,fuelItem:()=>null,outputItem:()=>input&&fuel?{name:'charcoal'}:null,putInput:async()=>{input=true;f.add('oak_log',-2)},putFuel:async()=>{fuel=true;f.add('oak_planks',-2)},takeOutput:async()=>{f.add('charcoal',2);input=false},close(){closed=true}})
 await charcoal(f.work,2);assert.equal(f.work.count('charcoal'),2);assert.equal(closed,true)
})

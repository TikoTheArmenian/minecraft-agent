const { EventEmitter }=require('node:events')
const { Vec3 }=require('vec3')
const registry=require('minecraft-data')('1.21.1')
const Block=require('prismarine-block')(registry)
const Recipe=require('prismarine-recipe')(registry).Recipe
const { Survival }=require('../../src/survival.cjs')
const { CROPS }=require('../../src/work.cjs')
const { parse }=require('../../src/agent.cjs')
const key=p=>`${p.x},${p.y},${p.z}`
function fixture() {
  const blocks=new Map(),items=[],dug=[],crafted=[],placed=[],tilled=[],commands=[]
  const make=(name,p,age)=>{const b=Block.fromStateId(registry.blocksByName[name].minStateId,0);b.position=p.clone();if(age!==undefined)b.getProperties=()=>({age});return b}
  const set=(name,p,age)=>{const b=make(name,p,age);blocks.set(key(p),b);return b}
  function add(name,count=1){let i=items.find(i=>i.name===name);if(!i){i={name,type:registry.itemsByName[name].id,count:0};items.push(i)}i.count+=count;return i}
  const bot=Object.assign(new EventEmitter(),{
    username:'Marc',registry,_client:new EventEmitter(),game:{dimension:'overworld',gameMode:'survival'},health:20,food:20,oxygenLevel:20,
    entity:{id:1,position:new Vec3(0,64,0),effects:{}},entities:{},players:{},world:{},
    inventory:{items:()=>items.filter(i=>i.count>0),emptySlotCount:()=>20},
    blockAt:p=>blocks.get(key(p)) || make(p.y===63?'grass_block':p.y<63?'dirt':'air',p),
    findBlocks:({matching,maxDistance=32,count=256,point=bot.entity.position})=>[...blocks.values()].filter(b=>typeof matching==='function'?matching(b):Array.isArray(matching)?matching.includes(b.type):b.type===matching).filter(b=>b.position.distanceTo(point)<=maxDistance).sort((a,b)=>a.position.distanceTo(point)-b.position.distanceTo(point)).slice(0,count).map(b=>b.position),
    pathfinder:{movements:{},setMovements(m){this.movements=m},setGoal(){},goto:async goal=>{if(Number.isFinite(goal.x))bot.entity.position=new Vec3(goal.x,goal.y,goal.z)}},
    equip:async item=>{bot.heldItem=item},unequip:async()=>{bot.heldItem=null},lookAt:async()=>{},canSeeBlock:()=>true,canDigBlock:()=>true,stopDigging(){},clearControlStates(){},deactivateItem(){},
    recipesFor:(id,meta,min,table)=>Recipe.find(id,meta).filter(r=>(!r.requiresTable || table) && r.delta.every(d=>d.count>=0 || items.filter(i=>i.type===d.id).reduce((n,i)=>n+i.count,0)>=-d.count)),
    craft:async recipe=>{for(const d of recipe.delta)add(registry.items[d.id].name,d.count);crafted.push(registry.items[recipe.result.id].name)},
    dig:async b=>{
      dug.push(b.name);set('air',b.position);bot._client.emit('block_change',{location:b.position,type:registry.blocksByName.air.minStateId})
      const drops={stone:['cobblestone',1],deepslate:['cobbled_deepslate',1],iron_ore:['raw_iron',1],deepslate_iron_ore:['raw_iron',1],short_grass:['wheat_seeds',1],tall_grass:['wheat_seeds',1],melon:['melon_slice',5],wheat:['wheat',1],carrots:['carrot',3],potatoes:['potato',3]}
      const [name,count]=drops[b.name]||[b.name,1];if(registry.itemsByName[name])add(name,count)
      if(b.name==='wheat')add('wheat_seeds',2)
    },
    _genericPlace:async soil=>{tilled.push(soil.position);const b=set('farmland',soil.position);bot._client.emit('block_change',{location:soil.position,type:b.stateId})},
    _placeBlockWithOptions:async soil=>{const crop=Object.values(CROPS).find(c=>c.seed===bot.heldItem.name);const name=crop?.block||bot.heldItem.name;set(name,soil.position.offset(0,1,0),crop?0:undefined);placed.push(name);bot.heldItem.count--},
    consume:async()=>{bot.heldItem.count--;bot.food=Math.min(20,bot.food+5)}
  })
  const agent={bot,epoch:1,nav:1,baseMovements:{},state:{connection:'ready',task:{status:'running'},messages:[]},publish(){},refresh(){},say(text){this.state.messages.push(text)},command(text){commands.push(parse(text))},disconnect(){this.nav++;this.bot=null;this.state.connection='disconnected'}}
  const work=new Survival(agent,1)
  work.approach=async p=>{work.check();bot.entity.position=p.offset(2,1,0)}
  work.pause=async()=>work.check()
  return {bot,agent,work,blocks,set,add,items,dug,crafted,placed,tilled,commands}
}
module.exports={fixture,Vec3,registry}

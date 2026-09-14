/** Fixed warehouse bays: south-facing pairs, one front label, and two-block aisles. */
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { plain } = require('./storage-policy.cjs')
const { watchBlock } = require('./block-updates.cjs')
const storage = require('./storage.cjs')
const v = p => new Vec3(p.x,p.y,p.z)
const key = p => `${p.x},${p.y},${p.z}`
function bays(hub) {
  const result=[]
  for(const z of [-4,0,4])for(const x of [-5,-1,3]) {
    const left=v(hub).offset(x,0,z), right=left.offset(1,0,0)
    result.push({id:key(left),left,right,facing:'south',sign:left.offset(0,0,1)})
  }
  return result
}
function memory(w,hub) {
  const m=w.agent.coordination?.recall()
  if(!m)throw new Error('Warehouse construction needs persistent coordinator memory.')
  m.warehouse ||= {}
  return m.warehouse[key(hub)] ||= {pending:null,completed:{}}
}
function validPair(bot,bay) {
  try {const a=bot.blockAt(bay.left), b=bot.blockAt(bay.right)
    return a?.getProperties().facing==='south' && b?.getProperties().facing==='south' && storage.identity(bot,a).capacity===54 && storage.identity(bot,a).container===storage.identity(bot,b).container
  }catch{return false}
}
function free(bot,bay) {
  for(const p of [bay.left,bay.right]) {
    for(const dy of [0,1])if(!['air','cave_air'].includes(bot.blockAt(p.offset(0,dy,0))?.name))return false
    for(const d of [[-1,0,0],[1,0,0],[0,0,-1],[0,0,1]])if(bot.blockAt(p.offset(...d))?.name==='chest')return false
  }
  // The fixed front label and walking strip must remain clear; never excavate a farm or structure.
  for(const p of [bay.left,bay.right])for(const z of [1,2])for(const y of [0,1])
    if(!['air','cave_air'].includes(bot.blockAt(p.offset(0,y,z))?.name))return false
  return true
}
async function placeConfirmed(w,p,name,reference,face) {
  w.check()
  const item=w.bot.inventory.items().find(i=>i.name===name&&plain(i))
  if(!item)throw new Error(`Warehouse needs ${name}.`)
  await w.equip(item)
  const range=w.bot.registry.blocksByName[name]
  const watcher=watchBlock(w.bot,p,id=>id>=range.minStateId&&id<=range.maxStateId,w.controller.signal)
  try {await w.timed(async()=>{await w.bot.placeBlock(reference,face);await watcher.promise;w.check()},7000,`Place warehouse ${name}`)}finally{watcher.cleanup()}
}
async function floor(w,bay) {
  const pending=[]
  for(const p of [bay.left,bay.right])for(const dz of [0,1,2])pending.push(p.offset(0,-1,dz))
  const safe=b=>b?.boundingBox==='block'&&!/chest|farmland|furnace|leaves|magma|cactus/.test(b.name)
  for(let pass=0;pass<6;pass++) {
    let progress=false
    for(let i=pending.length-1;i>=0;i--) {
      const p=pending[i],b=w.bot.blockAt(p)
      if(safe(b)){pending.splice(i,1);continue}
      if(!['air','cave_air'].includes(b?.name))throw new Error('Warehouse floor would overwrite terrain or a container. Clear or relocate the hub.')
      // Keep old chest lids and crops clear even when their cell is below the platform.
      if(/chest|farmland/.test(w.bot.blockAt(p.offset(0,-1,0))?.name||''))throw new Error('Warehouse floor would obstruct existing storage or farmland.')
      for(const d of [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) {
        const reference=w.bot.blockAt(p.offset(...d))
        if(!safe(reference))continue
        await storage.approach(w,reference.position)
        const name=['cobblestone','stone','dirt'].find(n=>w.bot.inventory.items().some(i=>i.name===n&&plain(i)))
        if(!name)throw new Error('Warehouse needs solid blocks for its level floor and aisle.')
        await placeConfirmed(w,p,name,reference,new Vec3(-d[0],-d[1],-d[2]))
        pending.splice(i,1);progress=true;break
      }
    }
    if(!pending.length)return
    if(!progress)break
  }
  throw new Error('Warehouse floor has no reachable support; choose a level supported storage area.')
}
async function build(w,hub,category) {
  const state=memory(w,hub), all=bays(hub)
  let bay=state.pending ? all.find(b=>b.id===state.pending.id) : all.find(b=>!state.completed[b.id]&&free(w.bot,b))
  if(!bay)throw new Error('No clear warehouse bay remains in the hub. The planned rows need a larger clear site.')
  const data=await storage.list(w)
  const overlaps=data.containers.filter(c=>c.blocks.some(p=>key(p)===key(bay.left)||key(p)===key(bay.right)))
  if(overlaps.length && !overlaps.every(c=>c.capacity===54&&c.id===`${key(bay.left)}|${key(bay.right)}`))throw new Error('A registered chest overlaps this warehouse bay; do not join it until its inventories are reconciled.')
  if(!state.pending){state.pending={id:bay.id,category};w.agent.coordination.save()}
  category=state.pending.category
  await floor(w,bay)
  for(const p of [bay.left,bay.right]) {
    const existing=w.bot.blockAt(p)
    if(existing?.name==='chest') {
      if(existing.getProperties().facing!=='south')throw new Error('Incomplete warehouse chest faces the wrong way; inspect it before repair.')
      continue
    }
    if(!['air','cave_air'].includes(existing?.name))throw new Error('Warehouse bay changed during construction.')
    // Looking north from this fixed southern stance makes both chest fronts face south.
    await w.travel(new goals.GoalBlock(p.x,p.y,p.z+2),'Stand in warehouse aisle')
    w.bot.setControlState('sneak',false)
    await placeConfirmed(w,p,'chest',w.bot.blockAt(p.offset(0,-1,0)),new Vec3(0,1,0))
    if(w.bot.blockAt(p)?.getProperties().facing!=='south')throw new Error('Server did not confirm the planned chest facing.')
  }
  if(!validPair(w.bot,bay))throw new Error('Server did not confirm a joined south-facing double chest.')
  await storage.manage(w,bay.left,category)
  state.completed[bay.id]={category};state.pending=null;w.agent.coordination.save()
  return bay
}
function pendingPositions(w) {
  const warehouse=w.agent.coordination?.recall()?.warehouse||{}
  return Object.values(warehouse).flatMap(s=>{
    if(!s.pending)return []
    const [x,y,z]=s.pending.id.split(',').map(Number)
    return [s.pending.id,key(new Vec3(x+1,y,z))]
  })
}
module.exports={bays,validPair,free,build,pendingPositions}

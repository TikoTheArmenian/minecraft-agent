/** Central storage maintenance: verified moves, physical labels, bounded tool stock. */
const { randomUUID } = require('node:crypto')
const { Vec3 } = require('vec3')
const storage = require('./storage.cjs')
const crafting = require('./crafting.cjs')
const { category, plain, describe } = require('./storage-policy.cjs')
const vector = p => new Vec3(p.x, p.y, p.z)
const atHub = (chest, hub) => vector(chest.position).distanceTo(vector(hub)) <= 8
const TOOL_STOCK = ['iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_hoe', 'iron_sword']
function destinations(containers, hub, item, registry, exclude) {
  const cat = category(item, registry)
  return containers.filter(c => c.managed && c.id !== exclude && atHub(c, hub) && (c.category === cat || c.category === 'overflow'))
    .sort((a,b) => Number(a.category === 'overflow') - Number(b.category === 'overflow'))
}
async function consolidate(w, hub) {
  const data = await storage.list(w)
  for (const chest of data.containers) {
    if (vector(chest.position).distanceTo(w.origin) > 80) continue
    for (const item of chest.slots) {
      if (atHub(chest, hub) && (chest.category === category(item,w.bot.registry) || (chest.category === 'overflow' && !data.containers.some(c=>c.managed && atHub(c,hub) && c.category===category(item,w.bot.registry))))) continue
      if (data.reservations.some(r => r.container === chest.id && r.fingerprint === item.fingerprint)) continue
      const targets = destinations(data.containers, hub, item, w.bot.registry, chest.id)
      if (!targets.length) continue
      // Never start a move into an area whose observed capacity is already exhausted.
      const space = targets.reduce((n,c) => n + Math.max(0,c.capacity-c.slots.length)*(item.stackSize || 64) + c.slots.filter(i=>i.fingerprint===item.fingerprint).reduce((m,i)=>m+Math.max(0,(i.stackSize||64)-i.count),0),0)
      if (!space) continue
      w.progress(`Consolidating ${item.name} into central storage.`)
      const moved = await storage.withChest(w,chest.position,ctx=>storage.transfer(w,ctx,'withdraw',item.fingerprint,Math.min(item.count,space)))
      if (!moved) continue
      const deposited = await storage.store(w,{fingerprint:item.fingerprint,count:moved,exclude:chest.id})
      if (deposited !== moved) {
        // Return leftovers to the source if another worker filled the destination.
        await storage.withChest(w,chest.position,ctx=>storage.transfer(w,ctx,'deposit',item.fingerprint,moved-deposited))
        throw new Error('Central storage filled during consolidation. Add capacity at the hub.')
      }
      const current = await storage.list(w)
      data.containers = current.containers
    }
  }
}
function signText(block) {
  const nbt = require('prismarine-nbt')
  let entity = block?.entity
  if (entity?.type) entity = nbt.simplify(entity)
  const messages = entity?.front_text?.messages
  if (messages) return messages.map(s=>{try {const t=JSON.parse(s); return typeof t==='string'?t:t.text||''}catch{return s}}).join('\n').trim()
  return Array.isArray(block?.signText) ? block.signText.join('\n').trim() : block?.signText?.trim?.() || ''
}
async function label(w, hub) {
  const { containers } = await storage.list(w)
  for (const chest of containers.filter(c=>c.managed && atHub(c,hub))) {
    const p = vector(chest.position)
    const title = chest.category === 'overflow' ? 'Tools & supplies' : chest.category[0].toUpperCase()+chest.category.slice(1)
    const text = `Colony storage\n${title}\nShared by all\nSam`
    await storage.approach(w,p)
    const faces = [new Vec3(0,0,-1),new Vec3(0,0,1),new Vec3(1,0,0),new Vec3(-1,0,0)]
    const existing = faces.map(f=>w.bot.blockAt(p.plus(f))).find(b=>b?.name.endsWith('_wall_sign') && signText(b)===text)
    if (existing) continue
    faces.sort((a,b)=>p.plus(a).distanceTo(w.bot.entity.position)-p.plus(b).distanceTo(w.bot.entity.position))
    const face = faces.find(f=>w.bot.blockAt(p.plus(f))?.name==='air')
    const item = w.bot.inventory.items().find(i=>/_sign$/.test(i.name) && !i.name.includes('hanging') && plain(i))
    if (!face || !item) {w.progress(`Need a sign and a clear chest face to label ${chest.id}.`);continue}
    const target=p.plus(face)
    let wrote=false
    const editor = block=>{if(block?.position.equals(target)){w.bot.updateSign(block,text);wrote=true}}
    w.bot.on('signOpen',editor)
    try {
      await w.equip(item)
      w.bot.setControlState('sneak',true)
      await w.timed(()=>w.bot.placeBlock(w.bot.blockAt(p),face),7000,`Label ${title} chest`)
      await w.timed(async()=>{while(!wrote || signText(w.bot.blockAt(target))!==text){w.check();await w.pause(100)}},5000,'Confirm chest sign text')
      w.counts.signsPlaced=(w.counts.signsPlaced||0)+1
      w.sync()
    } finally {w.bot.removeListener('signOpen',editor);w.bot.setControlState('sneak',false)}
  }
}
function expansionCategory(containers, hub) {
  const groups=new Map()
  for(const c of containers.filter(c=>c.managed && atHub(c,hub)))
    groups.set(c.category,(groups.get(c.category)||0)+Math.max(0,c.capacity-c.slots.length))
  return [...groups].filter(([,free])=>free<4).sort((a,b)=>a[1]-b[1])[0]?.[0] || null
}
async function expand(w,hub) {
  const data=await storage.list(w), cat=expansionCategory(data.containers,hub)
  if(!cat)return false
  w.progress(`Expanding central ${cat} storage.`)
  const hasChest=()=>w.bot.inventory.items().some(i=>i.name==='chest' && plain(i))
  if(!hasChest()) await storage.retrieve(w,['chest'],1)
  if(!hasChest()) {
    let stock=crafting.stocks(w,await storage.list(w))
    try {crafting.planRecipes(w.bot,'chest',1,stock.carry,stock.shared)} catch {
      // A small material trip, not an unbounded tree-farming job.
      const logs=Object.keys(w.bot.registry.blocksByName).filter(n=>/^(oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_log$/.test(n))
      await storage.retrieve(w,logs,4)
      const enough=()=>w.bot.inventory.items().filter(i=>logs.includes(i.name)).reduce((n,i)=>n+i.count,0)>=4
      if(!enough()) {
        const candidates=w.bot.findBlocks({matching:logs.map(n=>w.bot.registry.blocksByName[n].id),maxDistance:32,count:32})
        for(const p of candidates.slice(0,8)) {
          if(enough())break
          w.check()
          const natural=b=>!!b && logs.includes(b.name) && [[0,1,0],[0,2,0],[1,1,0],[-1,1,0],[0,1,1],[0,1,-1]].some(d=>/_leaves$/.test(w.bot.blockAt(b.position.offset(...d))?.name||''))
          let block=w.bot.blockAt(p)
          if(!natural(block))continue
          await w.approach(p);block=w.bot.blockAt(p)
          await w.dig(p,block.name,natural);await w.pickup(p)
        }
      }
    }
    stock=crafting.stocks(w,await storage.list(w))
    crafting.planRecipes(w.bot,'chest',1,stock.carry,stock.shared)
    const job=randomUUID()
    await storage.call(w,'enqueue',{job,item:'chest',quantity:1})
    const claimed=await storage.call(w,'claim_job',{job})
    if(!claimed)throw new Error('Storage expansion chest job is already claimed.')
    await crafting.execute(w,claimed,{storeOutput:false})
  }
  // Recheck after the material trip; do not grow capacity already added by another worker.
  const currentCategory=expansionCategory((await storage.list(w)).containers,hub)
  if(!currentCategory)return false
  await storage.approach(w,vector(hub))
  const chest=await crafting.place(w,'chest',hub)
  await storage.manage(w,chest.position,currentCategory)
  w.counts.chestsAdded=(w.counts.chestsAdded||0)+1;w.sync()
  if(w.agent.coordination)w.agent.coordination.nextCheck=0
  return true
}
async function tools(w, hub) {
  for (const name of TOOL_STOCK) {
    const data=await storage.list(w)
    const chests=data.containers.filter(c=>c.managed && atHub(c,hub))
    if (!chests.some(c=>['tools','overflow'].includes(c.category))) return
    const carried=w.bot.inventory.items().filter(i=>i.name===name && plain(i))
    for(const item of carried) await storage.store(w,{fingerprint:describe(item).fingerprint,count:item.count})
    const fresh=await storage.list(w)
    const carriedCount=w.bot.inventory.items().filter(i=>i.name===name && plain(i)).reduce((n,i)=>n+i.count,0)
    const count=carriedCount+fresh.containers.filter(c=>c.managed && atHub(c,hub)).flatMap(c=>c.slots).filter(i=>i.name===name && plain(i)).reduce((n,i)=>n+i.count,0)
    if(count>=4) continue
    const quantity=4-count
    const stock=crafting.stocks(w,fresh)
    try {crafting.planRecipes(w.bot,name,quantity,stock.carry,stock.shared)} catch(error){w.progress(`Tool restock waiting: ${error.message}`);continue}
    w.progress(`Crafting ${quantity} ${name} for the colony.`)
    const job=randomUUID()
    await storage.call(w,'enqueue',{job,item:name,quantity})
    const claimed=await storage.call(w,'claim_job',{job})
    if(claimed) await crafting.execute(w,claimed)
  }
}
module.exports={expand,expansionCategory,atHub,destinations,consolidate,label,tools,signText,TOOL_STOCK}

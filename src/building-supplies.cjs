/** Refill a useful building batch before more work; shared storage always comes first. */
const { BUILDING_BLOCKS } = require('./travel.cjs')
const TARGET = 128
const count = (w, names = BUILDING_BLOCKS) => w.bot.inventory.items().filter(i => names.includes(i.name)).reduce((n,i)=>n+i.count,0)
async function ensure(w, { names = BUILDING_BLOCKS, threshold = 8 } = {}) {
  if (count(w,names) >= threshold || w.refillingBuilding) return
  w.refillingBuilding = true
  try {
    w.check()
    w.progress(`Restocking building blocks to ${TARGET}; checking storage first.`)
    if (w.agent.colony?.enabled) await require('./storage.cjs').retrieve(w,names,TARGET)
    else {
      const local=Object.create(w)
      local.plan=w.plan || {}
      local.count=name=>count(w,[name])
      local.find=(types,radius)=>w.bot.findBlocks({matching:types.map(n=>w.bot.registry.blocksByName[n].id),maxDistance:radius,count:32}).map(p=>w.bot.blockAt(p)).filter(Boolean)
      local.attempt=async(label,fn)=>fn()
      await require('./farm-storage.cjs').restock(local,names,TARGET,threshold,'building blocks')
    }
    if (count(w,names) >= TARGET) return
    w.progress(`Gathering the remaining building blocks: ${count(w,names)}/${TARGET}.`)
    if (typeof w.gather === 'function') {
      await w.gather(['dirt','grass_block'],()=>count(w,names)>=TARGET,`building reserve (${TARGET} blocks)`,TARGET,false)
    } else {
      // Work-only skills have no Survival gatherer. Reuse verified work actions on exposed dirt.
      const origin=w.origin || w.bot.entity.position.clone()
      const safe=b=>{
        if(!b || !['dirt','grass_block'].includes(b.name) || b.position.distanceTo(origin)>80) return false
        if(!['air','cave_air'].includes(w.bot.blockAt(b.position.offset(0,1,0))?.name)) return false
        for(let x=-4;x<=4;x++)for(let z=-4;z<=4;z++)for(let y=0;y<=3;y++)
          if(w.bot.blockAt(b.position.offset(x,y,z))?.name==='farmland') return false
        return [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,-1,0]].every(d=>{
          const n=w.bot.blockAt(b.position.offset(...d));return n&&!/water|lava|chest|sign|furnace/.test(n.name)
        })
      }
      const candidates=w.bot.findBlocks({matching:['dirt','grass_block'].map(n=>w.bot.registry.blocksByName[n].id),maxDistance:32,count:256})
      let failures=0
      for(const p of candidates) {
        w.check()
        if(count(w,names)>=TARGET || failures>=8) break
        let b=w.bot.blockAt(p)
        if(!safe(b))continue
        try {await w.approach(p);b=w.bot.blockAt(p);if(!safe(b))continue;await w.dig(p,b.name,safe);await w.pickup(p)}
        catch(error){w.check();if(error.fatal)throw error;failures++;w.addIssue(error.message)}
      }
    }
    if(count(w,names)<TARGET) throw new Error(`Building supplies: ${count(w,names)}/${TARGET}. Storage and nearby safe gathering could not supply the full batch.`)
  } finally {w.refillingBuilding=false}
}
module.exports={TARGET,count,ensure}

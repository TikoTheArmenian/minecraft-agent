// Chest contents are observations, not a live inventory. Always reopen before
// withdrawing: players may have changed the contents since our last visit.
function remember(w,chest,window) {
  w.plan.chestContents ||= {}
  w.plan.chestContents[chest.position.toString()]={position:{...chest.position},checkedAt:Date.now(),items:window.containerItems().map(i=>({name:i.name || w.bot.registry.items[i.type]?.name,count:i.count}))}
  w.agent.publish()
}
async function restockSeeds(w) {
  if(w.count('wheat_seeds')>=8)return
  w.seedChestChecks ||= new Map()
  const chests=w.find(['chest'],32)
  for(const p of w.storage || []){
    const b=w.bot.blockAt(p)
    if(b?.name==='chest' && !chests.some(c=>c.position.equals(p)))chests.unshift(b)
  }
  for(const chest of chests.slice(0,8)) {
    w.check()
    if(w.count('wheat_seeds')>=32)break
    const key=chest.position.toString()
    if((w.seedChestChecks.get(key)||0)>Date.now())continue
    // Bound retries for empty or inaccessible chests without trusting old stock.
    w.seedChestChecks.set(key,Date.now()+60000)
    await w.attempt('Retrieve planting seeds',async()=>{
      w.decide('Checking farm storage for planting seeds before gathering grass.')
      await w.approach(chest.position)
      const window=await w.timed(async()=>{
        const opened=await w.bot.openContainer(chest)
        try{w.check()}catch(error){opened.close();throw error}
        return opened
      },7000,'Open seed storage chest')
      try {
        w.check();remember(w,chest,window)
        const type=w.bot.registry.itemsByName.wheat_seeds.id
        const available=()=>window.containerItems().filter(i=>i.type===type).reduce((n,i)=>n+i.count,0)
        const before=w.count('wheat_seeds'),stored=available()
        const stacks=w.bot.inventory.items().filter(i=>i.type===type)
        const capacity=w.bot.inventory.emptySlotCount()*64+stacks.reduce((n,i)=>n+Math.max(0,64-i.count),0)
        const count=Math.min(32-before,stored,capacity)
        if(count<=0)return
        await w.timed(()=>window.withdraw(type,null,count),10000,`Retrieve ${count} planting seeds`)
        if(w.count('wheat_seeds')-before!==count || stored-available()!==count)throw new Error('Seed withdrawal was not fully confirmed.')
        w.counts.seedsRetrieved=(w.counts.seedsRetrieved || 0)+count;w.sync();w.agent.refresh()
        // Successful refills can be used again as soon as planting consumes them.
        w.seedChestChecks.delete(key)
      } finally {remember(w,chest,window);window.close()}
    })
  }
}
module.exports={remember,restockSeeds}

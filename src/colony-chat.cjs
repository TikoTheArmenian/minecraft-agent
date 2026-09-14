/** Named, bounded colony conversations. Chat conveys observations and destinations, never code. */
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { Vec3 } = require('vec3')
// Roles come from the fleet profile list so a new bot only needs one entry in src/fleet.cjs.
const ROLES = Object.fromEntries(require('./fleet.cjs').profiles.map(p => [p.username, p.profession]))
const NEEDS = {
  farmer: ['iron_hoe','iron_shovel'], 'tree farmer':['iron_axe','iron_shovel'], 'movement explorer':['iron_pickaxe','iron_shovel'],
  'ore finder': ['iron_pickaxe','iron_shovel'], 'sugarcane farmer': ['iron_shovel'], 'mob killer': ['iron_sword'],
  terraformer: ['iron_shovel','iron_pickaxe'], smelter: ['iron_pickaxe'],
}
const SUPPLIES = {
  farmer: {wheat_seeds:32,dirt:128}, 'tree farmer': {dirt:128}, 'movement explorer': {dirt:128},
  'ore finder': {torch:16}, 'sugarcane farmer': {sugar_cane:8}, 'mob killer': {},
  terraformer: {dirt:128}, smelter: {},
}
function hasTool(items,name) {
  const tiers=['wooden','golden','stone','iron','diamond','netherite']
  const split=name.indexOf('_'), tier=tiers.indexOf(name.slice(0,split)), kind=name.slice(split)
  return items.some(i=>i.count>0 && i.name.endsWith(kind) && tiers.indexOf(i.name.slice(0,i.name.indexOf('_')))>=tier)
}
const coords = p => `${p.x} ${p.y} ${p.z}`
class ColonyChat {
  constructor(agent) {
    this.agent=agent
    this.file=path.join(agent.dataDir,'colony-memory.json')
    try {this.memory=JSON.parse(fs.readFileSync(this.file,'utf8'))} catch {this.memory={}}
    this.queue=[];this.nextSend=0;this.nextCheck=0;this.busy=false;this.pending=new Map()
  }
  scope() {return JSON.stringify([this.agent.state.world,this.agent.state.dimension])}
  recall() {return this.memory[this.scope()] ||= {role:ROLES[this.agent.username]||'general worker',peers:{}}}
  save() {
    fs.mkdirSync(path.dirname(this.file),{recursive:true})
    fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.memory,null,2),{mode:0o600})
    fs.renameSync(this.file+'.tmp',this.file)
    this.agent.state.colonyMemory=this.recall()
  }
  say(name,text) {
    const message=`${name}: ${text}`
    if(message.length>250 || this.queue.length>=64) return
    if(!this.queue.some(q=>q.message===message))this.queue.push({message,scope:this.scope(),epoch:this.agent.epoch})
  }
  peer(name) {return Object.values(this.agent.fleet||{}).find(a=>a.username===name && a!==this.agent && a.state.connection==='ready' && a.state.world===this.agent.state.world && a.state.dimension===this.agent.state.dimension)}
  receive(bot,name,message) {
    if(bot!==this.agent.bot || !this.peer(name) || typeof message!=='string' || !message.startsWith(this.agent.username+': ')) return false
    const text=message.slice(this.agent.username.length+2), m=this.recall()
    if(name==='Sam' && this.agent.username!=='Sam') {
      if(text==='What do you do?') {this.say('Sam',`My role is ${m.role}.`);return true}
      if(text==='What do you have, and what do you need?') {
        const items={}
        for(const i of bot.inventory.items())items[i.name]=(items[i.name]||0)+i.count
        const entries=Object.entries(items).map(([n,c])=>`${n}=${c}`)
        let part=[]
        for(const entry of entries){if([...part,entry].join(', ').length>170){this.say('Sam',`Inventory: ${part.join(', ')}.`);part=[]}part.push(entry)}
        this.say('Sam',`Inventory: ${part.join(', ')||'empty'}.`)
        const needs=(NEEDS[m.role]||['iron_pickaxe']).filter(n=>!hasTool(bot.inventory.items(),n))
        for(const [name,count] of Object.entries(SUPPLIES[m.role]||{}))if((items[name]||0)<count)needs.push(name)
        this.say('Sam',`Needs: ${needs.join(', ')||'none'}.`)
        return true
      }
      let match=text.match(/^Storage update ([a-f0-9]{12}) begins\.$/)
      if(match){this.pending.set('Sam',{revision:match[1],locations:[],scope:this.scope()});return true}
      match=text.match(/^Store (tools|wood|building|food|materials|overflow) at (-?\d+) (-?\d+) (-?\d+)\.$/)
      if(match){const p=match.slice(2).map(Number),pending=this.pending.get('Sam');if(pending && pending.scope===this.scope() && Math.abs(p[0])<=30000000 && p[1]>=-64 && p[1]<=319 && Math.abs(p[2])<=30000000 && pending.locations.length<32)pending.locations.push({category:match[1],position:{x:p[0],y:p[1],z:p[2]}});return true}
      match=text.match(/^Remember storage update ([a-f0-9]{12}); return surplus every 5 minutes or when nearly full\.$/)
      if(match){const pending=this.pending.get('Sam');if(pending?.scope===this.scope() && pending.revision===match[1] && pending.locations.length){m.storage={...pending,returnEveryMs:300000,learnedAt:Date.now()};this.save();this.say('Sam',`Remembered storage update ${match[1]}.`);this.pending.delete('Sam')}return true}
      if(/^(Get tools at |Requested supplies: )/.test(text)){this.agent.log('colony.chat',`${name}: ${text}`);return true}
    }
    if(this.agent.username==='Sam') {
      const peer=m.peers[name] ||= {}
      let match=text.match(/^My role is ([a-z ]{1,40})\.$/)
      if(match){peer.role=match[1];peer.inventory=[];this.save();this.say(name,'What do you have, and what do you need?');return true}
      match=text.match(/^Inventory: ([a-z0-9_=, ]+)\.$/)
      if(match){peer.inventory ||= [];peer.inventory.push(...match[1].split(', ').filter(v=>/^[a-z_]+=\d+$/.test(v)).slice(0,36-peer.inventory.length));peer.inventoryReport=peer.inventory.join(', ');peer.inventoryAt=Date.now();this.save();return true}
      match=text.match(/^Needs: ([a-z_, ]+)\.$/)
      if(match){peer.needs=match[1]==='none'?[]:match[1].split(', ').filter(n=>/^(iron_(pickaxe|axe|shovel|hoe|sword)|dirt|wheat_seeds|torch|sugar_cane)$/.test(n));peer.inventoryAt=Date.now();peer.reportReady=true;peer.askedAt=0;this.save();this.nextCheck=0;return true}
      match=text.match(/^Remembered storage update ([a-f0-9]{12})\.$/)
      if(match && peer.sentRevision===match[1]){peer.ackRevision=match[1];peer.ackAt=Date.now();this.save();return true}
    }
    return false
  }
  async tick() {
    const a=this.agent, now=Date.now()
    if(a.state.connection!=='ready'||!a.bot)return
    if(this.queue.length && now>=this.nextSend){const q=this.queue.shift();if(q.scope===this.scope()&&q.epoch===a.epoch){a.bot.chat(q.message);a.log('colony.chat',q.message)}this.nextSend=now+1600}
    if(a.username!=='Sam'||!a.colony.enabled||now<this.nextCheck||this.busy)return
    this.nextCheck=now+10000;this.busy=true
    const scope=this.scope(),epoch=a.epoch
    try {
      const [data,{position:hub}]=await Promise.all([a.colony.call(a,'list'),a.colony.call(a,'hub_get')])
      if(scope!==this.scope()||epoch!==a.epoch||!hub)return
      const locations=data.containers.filter(c=>c.managed&&new Vec3(c.position.x,c.position.y,c.position.z).distanceTo(new Vec3(hub.x,hub.y,hub.z))<=8)
        .map(c=>({category:c.category,position:c.position})).sort((x,y)=>(x.category+coords(x.position)).localeCompare(y.category+coords(y.position)))
      if(!locations.length)return
      const revision=createHash('sha256').update(JSON.stringify(locations)).digest('hex').slice(0,12)
      const memory=this.recall()
      for(const worker of Object.values(a.fleet||{})) {
        const name=worker.username
        if(!this.peer(name))continue
        const peer=memory.peers[name] ||= {}
        if(now-(peer.askedAt||0)<90000)continue
        if(!peer.role){this.say(name,'What do you do?');peer.askedAt=now}
        else if(!peer.reportReady || now-(peer.inventoryAt||0)>300000){peer.inventory=[];peer.reportReady=false;this.say(name,'What do you have, and what do you need?');peer.askedAt=now}
        else if(peer.ackRevision!==revision || peer.needs?.join(',')!==peer.answeredNeeds){
          this.say(name,`Storage update ${revision} begins.`)
          for(const c of locations)this.say(name,`Store ${c.category} at ${coords(c.position)}.`)
          const tool=locations.find(c=>c.category==='tools')||locations.find(c=>c.category==='overflow')
          if(peer.needs?.length) {
            const available=peer.needs.filter(n=>data.containers.some(c=>locations.some(l=>coords(l.position)===coords(c.position)) && c.slots.some(i=>i.name===n && i.count>0)))
            this.say(name,`Requested supplies: ${peer.needs.join(', ')}. Stocked now: ${available.join(', ')||'none; waiting for materials'}.`)
          }
          if(tool)this.say(name,`Get tools at ${coords(tool.position)}. I make replacement iron tools here.`)
          this.say(name,`Remember storage update ${revision}; return surplus every 5 minutes or when nearly full.`)
          peer.sentRevision=revision;peer.askedAt=now;peer.answeredNeeds=peer.needs?.join(',')
        }
      }
      this.save()
    } catch(error){a.log('colony.chat.error',error.message,'warn')} finally{this.busy=false}
  }
  async returnSupplies(w) {
    const memory=this.recall(), policy=memory.storage
    if (Date.now() < (memory.nextSupplyAttemptAt || 0)) return
    try {
      await require('./building-supplies.cjs').ensure(w)
      if(!policy || !this.agent.colony.enabled || this.agent.username==='Sam')return
      if(Date.now()-(memory.lastReturnAt||0)<policy.returnEveryMs && w.bot.inventory.emptySlotCount()>=4)return
      // Run only at skill checkpoints; never interrupt a chest click or a tree climb.
      w.check()
      const storage=require('./storage.cjs')
      w.progress('Returning surplus to the shared storage Sam told me about.')
      await storage.store(w)
      for(const name of NEEDS[memory.role]||[])
        if(!hasTool(w.bot.inventory.items(),name))await storage.retrieve(w,[name],1)
      memory.lastReturnAt=Date.now()
      memory.nextSupplyAttemptAt=0
      this.save()
    } catch(error) {
      // Storage is a side trip, not evidence that the current tree is unreachable.
      // Stop, safety failures, and air recovery must still reach the skill runner.
      w.check()
      if(error.fatal || ['CANCELLED','AIR_RECOVERY'].includes(error.code))throw error
      memory.nextSupplyAttemptAt=Date.now()+60000
      this.save()
      w.addIssue(`Supply trip deferred for one minute; continuing farm work. ${error.message}`)
    }
  }
}
module.exports={ColonyChat,ROLES,NEEDS,SUPPLIES,hasTool}

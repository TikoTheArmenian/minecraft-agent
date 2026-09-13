const { EventEmitter }=require('node:events')
const { Vec3 }=require('vec3')
const { pathfinder }=require('mineflayer-pathfinder')
const { Physics,PlayerState }=require('prismarine-physics')
const { Work }=require('../../src/work.cjs')
const { TravelMovements,installReliableGoto }=require('../../src/travel.cjs')
const registry=require('minecraft-data')('1.21.1')
const Block=require('prismarine-block')(registry)
const key=p=>`${p.x},${p.y},${p.z}`

function fixture({bank=63,stock=8}={}) {
  const changes=new Map(),logs=[],placements=[],items=stock?[{name:'cobblestone',type:registry.itemsByName.cobblestone.id,count:stock}]:[]
  const make=(name,p)=>{const b=Block.fromStateId(registry.blocksByName[name].minStateId,0);b.position=p.clone();return b}
  const terrain=p=>p.y<59?'stone':p.x<=0 && p.y<=65?'stone':p.x>=5 && p.y<=bank?'dirt':p.y<=62?'water':'air'
  const bot=Object.assign(new EventEmitter(),{
    registry,version:'1.21.1',_client:new EventEmitter(),game:{minY:-64,gameMode:'survival'},
    entity:{id:1,position:new Vec3(-1.5,66,.5),velocity:new Vec3(0,0,0),onGround:true,attributes:{},effects:{},yaw:0,pitch:0},entities:{},
    inventory:{items:()=>items.filter(i=>i.count>0),slots:Array(46).fill(null)},controlState:{},jumpTicks:0,jumpQueued:false,
    blockAt(pos){const p=pos.floored();if(p.x< -5 || p.x>12 || Math.abs(p.z)>4 || p.y<58 || p.y>72)return null;return changes.get(key(p)) || make(terrain(p),p)},
    clearControlStates(){for(const k of ['forward','back','left','right','jump','sprint','sneak'])this.controlState[k]=false},
    setControlState(k,v){this.controlState[k]=v},stopDigging(){},
    async look(yaw,pitch){this.entity.yaw=yaw;this.entity.pitch=pitch},async lookAt(){},async equip(item){this.heldItem=item},
    async _placeBlockWithOptions(ref,face,options){
      const pos=ref.position.plus(face),block=make(this.heldItem.name,pos),old=this.blockAt(pos)
      if(options.forceLook!=='ignore')throw new Error('Unsafe delayed look')
      changes.set(key(pos),block);placements.push(pos);this.heldItem.count--
      this._client.emit('block_change',{location:pos,type:block.stateId});this.emit('blockUpdate',old,block)
    }
  })
  bot.world={getBlock:p=>bot.blockAt(p),raycast:require('prismarine-world/src/worldsync').prototype.raycast}
  bot.physics=Physics(registry,bot.world)
  bot.clearControlStates();pathfinder(bot)
  installReliableGoto(bot)
  bot.pathfinder.setMovements(new TravelMovements(bot))
  const agent={bot,nav:1,state:{connection:'ready',task:{id:1,status:'running'}},publish(){},refresh(){},log(event,message){logs.push({event,message})},disconnect(){this.nav++;this.bot=null;this.state.connection='disconnected'}}
  const work=new Work(agent,1)
  // Real movement graph and physics, deterministic server acknowledgements for
  // placement. Nothing teleports the bot in this fixture.
  async function simulate(operation,maxTicks=2200) {
    let done=false,error
    operation.then(()=>{done=true},e=>{error=e;done=true})
    try {
      for(let n=0;n<maxTicks && !done;n++) {
        bot.physics.simulatePlayer(new PlayerState(bot,bot.controlState),bot.world).apply(bot)
        bot.emit('physicsTick')
        await new Promise(r=>setTimeout(r,1))
      }
    } catch(error) { work.cancel();bot.pathfinder.setGoal(null);await operation.catch(()=>{});throw error }
    if(!done){work.cancel();bot.pathfinder.setGoal(null);await operation.catch(()=>{});throw new Error(`Simulation stalled at ${bot.entity.position}; ${JSON.stringify(logs.slice(-6))}`)}
    if(error)throw error
  }
  return {bot,work,agent,logs,placements,changes,items,make,simulate}
}
module.exports={fixture,Vec3,registry}

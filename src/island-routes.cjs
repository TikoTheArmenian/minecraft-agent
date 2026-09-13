const {Vec3}=require('vec3')
const DIRECTIONS=[new Vec3(1,0,0),new Vec3(-1,0,0),new Vec3(0,0,1),new Vec3(0,0,-1)]
const air=b=>b && ['air','cave_air','void_air'].includes(b.name)
const solid=b=>b?.boundingBox==='block' && b.shapes?.some(s=>s[4]===1) && !/farmland|chest|barrel|shulker|crafting_table|furnace|magma|cactus|leaves/.test(b.name)
const key=p=>`${p.x},${p.y},${p.z}`
// Build from reachable land outward, not from an imaginary seabed under the
// island. Each rise places a side support, then a block on top of that support.
// The bot advances only after both placements have server confirmation.
function* islandRoutes(bot,goal) {
 const center=bot.entity.position.floored(),plans=[]
 for(let dx=-6;dx<=6;dx++)for(let dz=-6;dz<=6;dz++){
  yield null
  for(let dy=-2;dy<=2;dy++){
   const staging=center.offset(dx,dy,dz),base=staging.offset(0,-1,0)
   if(!solid(bot.blockAt(base)) || !air(bot.blockAt(staging)) || !air(bot.blockAt(staging.offset(0,1,0))))continue
   for(const dir of DIRECTIONS)for(let rise=1;rise<=4;rise++){
    const placements=[];let previous=base
    for(let distance=1;distance<=8;distance++){
     const y=base.y+Math.min(distance,rise),p=new Vec3(base.x+dir.x*distance,y,base.z+dir.z*distance)
     if(!air(bot.blockAt(p.offset(0,1,0))) || !air(bot.blockAt(p.offset(0,2,0))))break
     if(solid(bot.blockAt(p))){
      const landing=p.offset(0,1,0)
      if(placements.length && goal.heuristic(landing)<goal.heuristic(staging))plans.push({kind:'island-ramp',placements,staging,landing,score:goal.heuristic(landing)+center.distanceTo(staging)+placements.length*4})
      break
     }
     if(!air(bot.blockAt(p)))break
     const stand=previous.offset(0,1,0)
     if(p.y>previous.y){
      const support=p.offset(0,-1,0)
      if(!air(bot.blockAt(stand.offset(0,1,0))) || !air(bot.blockAt(stand.offset(0,2,0))))break
      if(air(bot.blockAt(support)))placements.push({pos:support,ref:previous,face:dir,stand})
      else if(!solid(bot.blockAt(support)))break
      placements.push({pos:p,ref:support,face:new Vec3(0,1,0),stand,advance:p.offset(0,1,0)})
     }else placements.push({pos:p,ref:previous,face:dir,stand,advance:p.offset(0,1,0)})
     if(placements.length>16)break
     previous=p
    }
   }
  }
 }
 const unique=new Map(plans.map(p=>[p.placements.map(s=>key(s.pos)).join(';'),p]))
 return [...unique.values()]
}
module.exports={islandRoutes}

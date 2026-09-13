const {goals}=require('mineflayer-pathfinder')
// Follow the item itself. Integer radius goals can stop in a neighboring cell
// without entering the server's item-collection box, especially on farmland.
class PickupGoal extends goals.Goal {
  constructor(bot,entity){super();this.bot=bot;this.entity=entity;this.last=entity.position.clone()}
  heuristic(node){const p=this.entity.position;return Math.max(0,Math.hypot(node.x+.5-p.x,node.z+.5-p.z)-.6)+Math.max(0,Math.abs(node.y-p.y)-.75)}
  isEnd(node){
    if(!this.bot.entities[this.entity.id])return true
    const p=this.entity.position,dy=p.y-node.y
    return Math.hypot(node.x+.5-p.x,node.z+.5-p.z)<=.65 && dy>=-.75 && dy<=1.8
  }
  hasChanged(){if(this.last.distanceTo(this.entity.position)<.25)return false;this.last=this.entity.position.clone();return true}
}
module.exports={PickupGoal}

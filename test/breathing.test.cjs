const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {installBreathing}=require('../src/minecraft/breathing.cjs')
test('oxygen follows our own metadata even when another entity emits breath',()=>{
 const bot=new EventEmitter();bot.entity={metadata:{1:300}};installBreathing(bot)
 bot.oxygenLevel=320;bot.emit('breath');assert.equal(bot.oxygenLevel,20)
 bot.entity.metadata[1]=90;bot.oxygenLevel=1;bot.emit('breath');assert.equal(bot.oxygenLevel,6)
 bot.entity.metadata[1]=300;bot.emit('breath');assert.equal(bot.oxygenLevel,20)
})

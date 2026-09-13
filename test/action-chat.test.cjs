const test=require('node:test'),assert=require('node:assert/strict')
const {ActionChat,announcement}=require('../src/action-chat.cjs')
test('INFO work is announced while movement, inbound chat and duplicate LLM replies are excluded',()=>{
 for(const [event,text] of [['path.update','Path success'],['travel.swimming','Swimming'],['action.start','Walk or swim to block 1,2,3'],['action.start','Face open water'],['command','farmer'],['chat.received','Player: Marc hello'],['bot.message','[Chat to Player] Hello']])assert.equal(announcement(event,text,'info'),null)
 assert.equal(announcement('action.start','Craft chest','info'),'Craft chest')
 assert.equal(announcement('travel.building','Placing a dirt shore step','info'),'Placing a dirt shore step')
 assert.equal(announcement('action.complete','Craft chest','debug'),null)
})
test('messages queue, deduplicate and never carry over to another connection',t=>{
 const sent=[],bot={chat:s=>sent.push(s)},agent={bot,epoch:1,state:{connection:'ready'}},chat=new ActionChat(agent,100000);t.after(()=>chat.clear())
 chat.add('action.start','Craft chest','info');chat.add('action.start','Craft chest','info');chat.add('action.start','Plant wheat','info');assert.equal(sent.length,1);chat.flush();assert.equal(sent.length,2)
 chat.add('action.start','Store wheat','info');agent.epoch++;chat.flush();assert.equal(sent.length,2)
 chat.add('action.start','Next task','info');chat.clear();chat.flush();assert.equal(sent.length,2)
})
test('announcements cannot become commands and chat errors do not interrupt the skill',t=>{
 const sent=[],agent={bot:{chat:s=>sent.push(s)},epoch:1,state:{connection:'ready'}},chat=new ActionChat(agent,100000);t.after(()=>chat.clear())
 chat.add('bot.message','/kill\n§x','info');assert.ok(sent[0].startsWith('[Action] '));assert.equal(sent[0].includes('\n'),false)
 agent.bot.chat=()=>{throw new Error('disconnected')};chat.add('action.start','Plant wheat','info');assert.doesNotThrow(()=>chat.flush())
})

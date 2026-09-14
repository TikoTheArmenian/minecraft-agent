const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {ColonyChat}=require('../src/colony-chat.cjs')
function fixture(t,name){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'colony-chat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const a={username:name,dataDir:dir,epoch:1,state:{world:'test',dimension:'overworld',connection:'ready'},log(){},bot:{inventory:{items:()=>[{name:'wheat',count:64}]}}};a.coordination=new ColonyChat(a);return a}
function pair(t){const sam=fixture(t,'Sam'),marc=fixture(t,'Marc');sam.fleet=marc.fleet={sam,marc};return {sam,marc}}
test('named role and stock exchange works without an LLM and persists learned roles',t=>{const {sam,marc}=pair(t);assert.equal(marc.coordination.receive(marc.bot,'Sam','Marc: What do you do?'),true);const reply=marc.coordination.queue.shift().message;sam.coordination.receive(sam.bot,'Marc',reply);assert.equal(new ColonyChat(sam).recall().peers.Marc.role,'farmer');marc.coordination.receive(marc.bot,'Sam','Marc: What do you have, and what do you need?');assert.ok(marc.coordination.queue.some(q=>q.message.includes('wheat=64')));assert.ok(marc.coordination.queue.some(q=>q.message.includes('iron_hoe')));assert.equal(marc.coordination.receive(marc.bot,'Jerry','Marc: What do you do?'),false)})
test('locations commit only after a complete addressed update, survive restart and stay world scoped',t=>{const{marc}=pair(t),c=marc.coordination;const receive=text=>c.receive(marc.bot,'Sam',`Marc: ${text}`);receive('Storage update abcdef123456 begins.');receive('Store food at -469 65 1061.');assert.equal(c.recall().storage,undefined);receive('Remember storage update abcdef123456; return surplus every 5 minutes or when nearly full.');assert.equal(new ColonyChat(marc).recall().storage.locations[0].position.x,-469);assert.ok(c.queue.some(q=>q.message==='Sam: Remembered storage update abcdef123456.'));marc.state.dimension='nether';assert.equal(c.recall().storage,undefined)})
test('Sam updates changed chest locations and waits for acknowledgement',async t=>{const{sam}=pair(t),c=sam.coordination;sam.bot.chat=()=>{};sam.colony={enabled:true,call:async(a,action)=>action==='hub_get'?{position:{x:0,y:64,z:0}}:{containers:[{managed:true,category:'food',position:{x:1,y:64,z:0},slots:[]}]} };c.recall().peers.Marc={role:'farmer',reportReady:true,inventoryAt:Date.now(),needs:[]};await c.tick();const peer=c.recall().peers.Marc;assert.equal(peer.ackRevision,undefined);assert.ok(c.queue.some(q=>q.message.includes('Store food at 1 64 0')));c.receive(sam.bot,'Marc',`Sam: Remembered storage update ${peer.sentRevision}.`);assert.equal(peer.ackRevision,peer.sentRevision);c.queue=[];peer.askedAt=0;c.nextCheck=0;await c.tick();assert.equal(c.queue.length,0)})
test('better tools do not cause requests for inferior replacements',()=>{const{hasTool}=require('../src/colony-chat.cjs');assert.equal(hasTool([{name:'netherite_hoe',count:1}],'iron_hoe'),true);assert.equal(hasTool([{name:'stone_hoe',count:1}],'iron_hoe'),false)})
test('a new chest triggers an update even after the previous layout was acknowledged',async t=>{
  const{sam}=pair(t),c=sam.coordination
  const containers=[{managed:true,category:'food',position:{x:1,y:64,z:0},slots:[]}]
  sam.bot.chat=()=>{}
  sam.colony={enabled:true,call:async(a,action)=>action==='hub_get'?{position:{x:0,y:64,z:0}}:{containers}}
  c.recall().peers.Marc={role:'farmer',reportReady:true,inventoryAt:Date.now(),needs:[]}
  await c.tick()
  const peer=c.recall().peers.Marc,old=peer.sentRevision
  peer.ackRevision=old;peer.askedAt=0;c.queue=[];c.nextCheck=0
  containers.push({managed:true,category:'tools',position:{x:2,y:64,z:0},slots:[]})
  await c.tick()
  assert.notEqual(peer.sentRevision,old)
  assert.ok(c.queue.some(q=>q.message.includes('Store tools at 2 64 0')))
  assert.equal(peer.ackRevision,old)
})

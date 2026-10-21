'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createSource}=require('../source');
const SID='123456',EID='654321';
function get(url,headers={}){return new Promise((resolve,reject)=>{const req=http.get(url,{headers},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);});}
function fixture(t,chunk){let detailCalls=0;const provider={async detail(){detailCalls++;return{episodes:[{id:EID}]};},async qualities(){return[];},async stream(){return{total:16,chunk};}};const source=createSource(provider);t.after(()=>source.close());return {source,get detailCalls(){return detailCalls;}};}
test('expired media session revalidates registered episodes after a long pause',async t=>{
 const f=fixture(t,async(s,e)=>Buffer.alloc(e-s+1,7));const {url}=await f.source.play({seriesId:SID,episodeId:EID});
 const now=Date.now;Date.now=()=>now()+3600001;
 try{const r=await get(url,{Range:'bytes=5-9'});assert.equal(r.status,206);assert.equal(r.body.length,5);assert.equal(f.detailCalls,2);}finally{Date.now=now;}
});
test('ordinary media retries transient range errors before failing playback',async t=>{
 let calls=0;const f=fixture(t,async(s,e)=>{if(++calls<3)throw Error('transient');return Buffer.alloc(e-s+1,7);});
 const {url}=await f.source.play({seriesId:SID,episodeId:EID});const r=await get(url);assert.equal(r.status,200);assert.equal(r.body.length,16);assert.equal(calls,3);
});
test('ordinary media retries short ranges rather than advertising invalid Content-Length',async t=>{
 let calls=0;const f=fixture(t,async(s,e)=>{calls++;return Buffer.alloc(calls<3?1:e-s+1,7);});
 const {url}=await f.source.play({seriesId:SID,episodeId:EID});
 const r=await Promise.race([get(url),new Promise((_,reject)=>setTimeout(()=>reject(Error('truncated response')),1500).unref())]);assert.equal(r.status,200);assert.equal(r.body.length,16);assert.equal(calls,3);
});
test('unregistered episodes remain forbidden after session refresh',async t=>{
 const f=fixture(t,async(s,e)=>Buffer.alloc(e-s+1));const {url}=await f.source.play({seriesId:SID,episodeId:EID});
 const r=await get(url.replace('/654321/','/999999/'));assert.equal(r.status,403);assert.equal(f.detailCalls,1);
});
test('expired session does not retain episodes removed by refreshed details',async t=>{
 let removed=false;const source=createSource({async detail(){return {episodes:[{id:removed?'654322':EID}]};},async qualities(){return[];},async stream(){return{total:16,async chunk(s,e){return Buffer.alloc(e-s+1);}};}});t.after(()=>source.close());
 const {url}=await source.play({seriesId:SID,episodeId:EID});removed=true;const now=Date.now;Date.now=()=>now()+3600001;
 try{const r=await get(url);assert.equal(r.status,403);}finally{Date.now=now;}
});
test('permanent ordinary chunk failure stops after three attempts and hides upstream detail',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;throw Error('https://secret.invalid/?signed=hidden');});const {url}=await f.source.play({seriesId:SID,episodeId:EID});const r=await get(url);assert.equal(r.status,502);assert.equal(calls,3);assert.match(r.body.toString(),/视频获取失败/);assert.equal(r.body.includes(Buffer.from('secret.invalid')),false);
});
test('a transient failure after response headers does not truncate an ordinary video',async t=>{
 let nextCalls=0;const total=1024*1024+8;const source=createSource({async detail(){return{episodes:[{id:EID}]};},async qualities(){return[];},async stream(){return{total,async chunk(s,e){if(s>0&&++nextCalls<3)throw Error('transient');return Buffer.alloc(e-s+1,5);}};}});t.after(()=>source.close());
 const {url}=await source.play({seriesId:SID,episodeId:EID});const r=await get(url);assert.equal(r.status,200);assert.equal(r.body.length,total);assert.equal(nextCalls,3);
});
test('ordinary stream establishment retries both play preflight and media GET',async t=>{
 let calls=0;const source=createSource({async detail(){return{episodes:[{id:EID}]};},async qualities(){return[];},async stream(){calls++;if(calls===1||calls===3)throw Error('transient source resolve');return{total:16,async chunk(s,e){return Buffer.alloc(e-s+1,7);}};}});t.after(()=>source.close());
 const {url}=await source.play({seriesId:SID,episodeId:EID});assert.equal(calls,2);const r=await get(url,{Range:'bytes=4-7'});assert.equal(r.status,206);assert.equal(r.body.length,4);assert.equal(calls,4);
});
test('rapid switches queue the latest selection and discard superseded queued work',async t=>{
 const ids=Array.from({length:6},(_,i)=>String(654321+i));const gates=[];const calls=[];
 const source=createSource({async detail(){return{episodes:ids.map(id=>({id}))};},async qualities(){return[];},async stream(id){calls.push(id);if(calls.length<=4)await new Promise(resolve=>gates.push(resolve));return{total:16,async chunk(s,e){return Buffer.alloc(e-s+1);}};}});t.after(()=>source.close());
 const active=ids.slice(0,4).map(episodeId=>source.play({seriesId:SID,episodeId}));while(gates.length<4)await new Promise(r=>setImmediate(r));
 let fifthState='waiting',sixthState='waiting';const fifth=source.play({seriesId:SID,episodeId:ids[4]}).then(()=>{fifthState='played';},()=>{fifthState='superseded';});const sixth=source.play({seriesId:SID,episodeId:ids[5]}).then(r=>{sixthState='played';return r;});
 await new Promise(r=>setImmediate(r));assert.equal(fifthState,'superseded');assert.equal(sixthState,'waiting');assert.equal(calls.length,4);
 gates.forEach(r=>r());await Promise.all(active);await fifth;const latest=await sixth;assert.equal(sixthState,'played');assert.ok(latest.url.includes('/'+ids[5]+'/'));assert.deepEqual(calls,[...ids.slice(0,4),ids[5]]);
});

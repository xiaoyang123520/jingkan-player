'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createSource}=require('../source');
test('compatibility mode defaults to 720P and keeps protected range serving',async t=>{
 const calls=[];let closed=false,releases=0;
 const provider={detail:async()=>({episodes:[{id:'654321'}]}),qualities:async()=>[{key:'720P',label:'720P'}],stream:async()=>{throw Error('native path should not be used')}};
 const compat={prepare:async(...args)=>{calls.push(args);return {total:8,chunk:async(a,b)=>Buffer.alloc(b-a+1,7),release(){releases++}}},close:async()=>{closed=true}};
 const s=createSource(provider,{compat});t.after(()=>s.close());
 const p=await s.play({seriesId:'123456',episodeId:'654321',compat:true,fresh:true});
 assert.equal(p.quality,'720P');assert.ok(p.url.endsWith('/720P/compat'));assert.equal(s.isMediaUrl(p.url),true);
 assert.deepEqual(calls[0],['654321','720P',true]);
 const r=await fetch(p.url,{headers:{Range:'bytes=1-3'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,3);
 assert.deepEqual(calls[1],['654321','720P',false,true]);assert.equal(releases,1,'the media request releases its cache lease when finished');
 await s.close();assert.equal(closed,true);
});

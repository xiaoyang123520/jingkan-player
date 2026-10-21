'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const compat=require('../crypto-compat.cjs');
const native=require('node:crypto');
test('SM3 abc standard vector',()=>assert.equal(compat.createHash('sm3').update('abc').digest('hex'),'66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'));
test('SM3 block standard vector',()=>assert.equal(compat.createHash('sm3').update('abcd'.repeat(16)).digest('hex'),'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732'));
test('SM3 streaming buffers and native crypto parity',()=>{
 const data=Buffer.from('红果\u0000净看'.repeat(50));
 const h=compat.createHash('sm3');h.update(data.subarray(0,13));h.update(data.subarray(13));
 const digest=h.digest('hex'); if(native.getHashes().includes('sm3')) assert.equal(digest,native.createHash('sm3').update(data).digest('hex')); else assert.equal(digest.length,64);
 assert.throws(()=>h.digest());assert.throws(()=>h.update('x'));
});
test('other crypto primitives stay native',()=>{assert.equal(compat.createHash('sha512').update('abc').digest('hex'),native.createHash('sha512').update('abc').digest('hex'));assert.equal(compat.randomBytes(32).length,32);});

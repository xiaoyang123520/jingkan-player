'use strict';
// Electron uses BoringSSL, which does not implement SM3. Keep other primitives native.
const native=require('node:crypto');
const {sm3}=require('sm-crypto');
function createSm3() {
  const chunks=[]; let finalized=false;
  return {
    update(value,encoding) {
      if(finalized) throw new Error('Digest already called');
      chunks.push(Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(value,encoding));
      return this;
    },
    digest(encoding) {
      if(finalized) throw new Error('Digest already called');
      finalized=true;
      const result=Buffer.from(sm3(Array.from(Buffer.concat(chunks))),'hex');
      chunks.length=0;
      return encoding ? result.toString(encoding) : result;
    }
  };
}
module.exports={...native,createHash(algorithm,options){
  if(String(algorithm).toLowerCase()==='sm3') return createSm3();
  return native.createHash(algorithm,options);
}};

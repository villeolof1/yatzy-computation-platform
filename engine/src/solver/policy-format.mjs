import fs from 'node:fs';
import { sha256File } from '../util/hash.mjs';
export const POLICY_MAGIC='YTZPOL02';
export const POLICY_HEADER_SIZE=128;
export const POLICY_STRIDE=756;
export function createPolicyFile(file,stateCount,rulesHash){const fd=fs.openSync(file,'w+'),h=Buffer.alloc(POLICY_HEADER_SIZE);h.write(POLICY_MAGIC,0,'ascii');h.writeUInt16LE(2,8);h.writeUInt16LE(POLICY_HEADER_SIZE,10);h.writeUInt32LE(stateCount,12);h.writeUInt16LE(POLICY_STRIDE,16);Buffer.from(rulesHash,'hex').copy(h,24);fs.writeSync(fd,h,0,h.length,0);fs.ftruncateSync(fd,POLICY_HEADER_SIZE+stateCount*POLICY_STRIDE);return fd;}
export function openPolicyFile(file){return fs.openSync(file,'r+');}
export function writePolicyChunk(fd,indices,policy){let run=0;for(let p=1;p<=indices.length;p++){const end=p===indices.length||indices[p]!==indices[p-1]+1;if(!end)continue;const n=p-run,bytes=n*POLICY_STRIDE,buf=Buffer.from(policy.buffer,policy.byteOffset+run*POLICY_STRIDE,bytes);fs.writeSync(fd,buf,0,bytes,POLICY_HEADER_SIZE+indices[run]*POLICY_STRIDE);run=p;}}
export function verifyPolicyHeader(file,stateCount,rulesHash){const fd=fs.openSync(file,'r'),h=Buffer.alloc(POLICY_HEADER_SIZE);fs.readSync(fd,h,0,h.length,0);const stat=fs.fstatSync(fd);fs.closeSync(fd);const magic=h.toString('ascii',0,8),count=h.readUInt32LE(12),stride=h.readUInt16LE(16),hash=h.subarray(24,56).toString('hex'),expectedLength=POLICY_HEADER_SIZE+stateCount*POLICY_STRIDE;return{magic,count,stride,hash,length:stat.size,expectedLength,passed:magic===POLICY_MAGIC&&count===stateCount&&stride===POLICY_STRIDE&&hash===rulesHash&&stat.size===expectedLength};}
export async function policyHash(file){return sha256File(file);}
export function readPolicyShared(file,stateCount){const expected=stateCount*POLICY_STRIDE,fd=fs.openSync(file,'r'),shared=new SharedArrayBuffer(expected),target=new Uint8Array(shared),chunk=Buffer.allocUnsafe(16*1024*1024);let pos=0;while(pos<expected){const n=Math.min(chunk.length,expected-pos);const got=fs.readSync(fd,chunk,0,n,POLICY_HEADER_SIZE+pos);if(got!==n)throw new Error('Policy file truncated');target.set(chunk.subarray(0,n),pos);pos+=n;}fs.closeSync(fd);return shared;}

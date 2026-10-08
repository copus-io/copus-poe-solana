const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const path=require('node:path');

// Run the real adapter with deterministic RPC/transaction confirmations, without broadcasting.
async function harness(t) {
  let now=Date.parse('2030-01-01T00:00:00Z')/1000;
  const initial=now, calls=[];
  const prepared={manifestHash:'0x'+'1'.repeat(64),ruleHash:'0x'+'2'.repeat(64)};
  const file=path.join(__dirname,'../services/product-chain.js');
  const realRequire=createRequire(file);
  const module={exports:{}};
  t.mock.method(Date,'now',()=>now*1000);
  class PublicKey {constructor(value){this.value=value;}toBase58(){return this.value;}equals(other){return this.value===other.value;}}
  const issuer=new PublicKey('issuer'),program=new PublicKey('program');
  const connection={getAccountInfo:async address=>address==='config'?{owner:program,data:Buffer.alloc(0)}:{executable:true}};
  const env={POE_PROGRAM_ID:'program',SOLANA_KEYPAIR_PATH:'fixture-only',SOLANA_RPC_URL:'http://127.0.0.1:8899',POE_DEMO_MINT_TEST_TOKEN:'1'};
  class Transaction {add(ix){this.ix=ix;return this;}}
  const mocks={
    '@solana/web3.js':{PublicKey,Transaction,Connection:function(){return connection;},sendAndConfirmTransaction:async(c,tx)=>{calls.push({kind:'fund',start:tx.ix.startsAt,end:tx.ix.endsAt});return 'fund';}},
    '@solana/spl-token':{getOrCreateAssociatedTokenAccount:async()=>({address:'ata'}),mintTo:async()=>{calls.push({kind:'mint'});now+=90;}},
    '../scripts/client':{readKeypair:()=>({publicKey:issuer}),configPda:()=>'config',readConfig:()=>({issuer,fundingMint:'mint',treasury:'treasury',nextCampaignId:1}),fundAndActivate:(...args)=>args[6]},
    './rpc-network':{rpcFetch:()=>()=>{}},
  };
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:id=>id in mocks?mocks[id]:realRequire(id),module,exports:module.exports,process:{env},__dirname:path.dirname(file),Buffer,console,setTimeout,Date});
  const chain=await module.exports.createChain();
  return {initial,calls,now:()=>now,fund:draft=>chain.fund({mode:'ONGOING',totalTimeMinutes:6000,claimTimeMinutes:30,...draft},prepared,{})};
}

test('slow preparation refreshes an omitted start before campaign creation',async t=>{
  const h=await harness(t);const result=await h.fund({unlimited:true});
  assert.ok(h.now()-h.initial>30);
  assert.equal(result.startsAt,h.now()+30);
  assert.equal(h.calls.at(-1).start,result.startsAt);
});
test('slow preparation preserves a still-future explicit start',async t=>{
  const h=await harness(t);const start=h.initial+3600;
  const result=await h.fund({unlimited:true,startsAt:new Date(start*1000).toISOString()});
  assert.equal(result.startsAt,start);assert.equal(h.calls.at(-1).start,start);
});
test('explicit start that expires during preparation prevents campaign creation',async t=>{
  const h=await harness(t);
  await assert.rejects(h.fund({unlimited:true,startsAt:new Date((h.initial+40)*1000).toISOString()}),/Start time must be in the future/);
  assert.ok(h.calls.length>0);assert.ok(!h.calls.some(c=>c.kind==='fund'));
});
test('finite end is rechecked against the refreshed default start',async t=>{
  const h=await harness(t);
  await assert.rejects(h.fund({unlimited:false,endsAt:new Date((h.initial+60)*1000).toISOString()}),/End time must be after start time/);
  assert.ok(h.calls.length>0);assert.ok(!h.calls.some(c=>c.kind==='fund'));
});
test('invalid input still fails before preparation transactions',async t=>{
  const h=await harness(t);
  await assert.rejects(h.fund({unlimited:false}),/End time is required/);
  assert.deepEqual(h.calls,[]);
});

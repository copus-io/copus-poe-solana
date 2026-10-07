const { Connection, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, mintTo } = require('@solana/spl-token');
const { buildBatchV2 } = require('../lib/poe-v2');
const { prove } = require('./prover');
const { byte32 } = require('../scripts/proof');
const client = require('../scripts/client');
const { validateCampaignSchedule } = require('./campaign-schedule');

async function createChain() {
  if (!process.env.POE_PROGRAM_ID || !process.env.SOLANA_KEYPAIR_PATH) throw new Error('POE_PROGRAM_ID and SOLANA_KEYPAIR_PATH are required');
  const rpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  const local = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(rpc);
  const { rpcFetch } = require('./rpc-network');
  const connection = new Connection(rpc,{commitment:'confirmed',fetch:rpcFetch()});
  if (!local && await connection.getGenesisHash() !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('Solana Devnet required');
  const payer = client.readKeypair(process.env.SOLANA_KEYPAIR_PATH);
  const programId = new PublicKey(process.env.POE_PROGRAM_ID);
  if (!(await connection.getAccountInfo(programId))?.executable) throw new Error('PoE program is not deployed');
  const config = async () => {
    const info = await connection.getAccountInfo(client.configPda(programId));
    if (!info?.owner.equals(programId)) throw new Error('initialize the PoE program before starting the demo');
    return client.readConfig(info.data);
  };
  const cfg = await config();
  if (!cfg.issuer.equals(payer.publicKey)) throw new Error('demo wallet must be the configured issuer');
  const from = await getOrCreateAssociatedTokenAccount(connection,payer,cfg.fundingMint,payer.publicKey);
  const treasury = await getOrCreateAssociatedTokenAccount(connection,payer,cfg.fundingMint,cfg.treasury);
  // Use HTTP polling so public RPC WebSocket availability cannot break the demo.
  connection.confirmTransaction = async (strategy) => {
    const signature = typeof strategy === 'string' ? strategy : strategy.signature;
    for (let attempt=0;attempt<90;attempt++) {
      const result = await connection.getSignatureStatus(signature,{searchTransactionHistory:true});
      if(result.value?.err) throw new Error(`transaction failed: ${JSON.stringify(result.value.err)}`);
      if(['confirmed','finalized'].includes(result.value?.confirmationStatus)) return result;
      await new Promise((resolve)=>setTimeout(resolve,2000));
    }
    throw new Error(`confirmation unavailable; inspect ${signature} before retrying`);
  };
  const send = (ix) => sendAndConfirmTransaction(connection,new Transaction().add(ix),[payer],{commitment:'confirmed',maxRetries:5});
  async function issue(receipt,policy) {
    const batch = await buildBatchV2([receipt],policy);
    const batchId = (await config()).nextBatchId;
    await send(client.commitEvidence(programId,payer.publicKey,batchId,byte32(batch.root),byte32(batch.ruleHash)));
    const info = await connection.getAccountInfo(client.batchPda(programId,batchId),'confirmed');
    if(!info?.owner.equals(programId) || !info.data.subarray(40,72).equals(byte32(batch.root)) || !info.data.subarray(72,104).equals(byte32(batch.ruleHash))) throw new Error('evidence commitment mismatch');
    const path = batch.proof(0);
    return {batchId:batchId.toString(),root:batch.root.toString(),merkleProof:{pathElements:path.pathElements.map(String),pathIndices:path.pathIndices}};
  }
  return {
    label:local?'Local Solana · real v2 verifier':'Solana Devnet', live:!local,
    deployment:{programId:programId.toBase58()},
    link:(signature)=>local?null:`https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    async status(campaign,row) {
      const status=await connection.getSignatureStatus(row.tx,{searchTransactionHistory:true});
      if(status.value?.err)return {failed:'Claim failed on chain'};
      if(!status.value && row.expires_at_block && await connection.getBlockHeight('confirmed')>row.expires_at_block)return {failed:'Claim expired before confirmation. Please try again.'};
      if(status.value?.confirmationStatus!=='finalized')return null;
      if(!row.nullifier)return null;
      const pda=client.claimPda(programId,campaign.id,Buffer.from(row.nullifier,'hex'));
      const info=await connection.getAccountInfo(pda,'finalized');
      if(!info?.owner.equals(programId)||info.data.readBigUInt64LE(0)!==BigInt(row.epoch))return {failed:'Claim PDA mismatch'};
      const tx=await connection.getParsedTransaction(row.tx,{commitment:'finalized',maxSupportedTransactionVersion:0});
      if(!tx || tx.meta?.err)return null;
      const {parseClaim}=require('./indexer');
      const parsed=tx.transaction.message.instructions.map(ix=>parseClaim(ix,programId)).find(ix=>ix?.claimAccount.equals(pda)&&ix.campaignAccount.equals(client.campaignPda(programId,campaign.id))&&ix.epoch===BigInt(row.epoch));
      if(!parsed)return {failed:'No matching claim instruction'};
      return {eventKey:`${local?'solana-local':'solana-devnet'}:${row.tx}:0`,timeSeconds:campaign.draft.claimTimeMinutes*60};
    },
    async fund(draft,prepared,receipt) {
      const {startsAt:start,endsAt:end}=validateCampaignSchedule(draft);
      const retrospective = draft.mode==='RETROSPECTIVE';
      const batch = retrospective?await issue(receipt,prepared.provingPolicy):{};
      const id = (await config()).nextCampaignId;
      const period=draft.repeatClaim?draft.claimTimeMinutes*60:0;
      if (process.env.POE_DEMO_MINT_TEST_TOKEN === '1') await mintTo(connection,payer,cfg.fundingMint,from.address,payer,1_000_000);
      const signature=await send(client.fundAndActivate(programId,payer.publicKey,id,from.address,treasury.address,cfg.fundingMint,{
        paymentAmount:1_000_000,manifestHash:Buffer.from(prepared.manifestHash.slice(2),'hex'),ruleHash:Buffer.from(prepared.ruleHash.slice(2),'hex'),
        snapshotRoot:batch.root?byte32(BigInt(batch.root)):Buffer.alloc(32),mode:retrospective?1:0,startsAt:start,endsAt:end,
        totalTimeMinutes:draft.totalTimeMinutes,timePerClaimMinutes:draft.claimTimeMinutes,claimPeriodSeconds:period}));
      return {id:id.toString(),transactionHash:signature,startsAt:start,period,...batch,paymentUnits:'1000000'};
    },
    async epoch(campaign) { const slot=await connection.getSlot('confirmed'); const timestamp=await connection.getBlockTime(slot); if(timestamp===null)throw new Error('Chain clock unavailable'); return campaign.period?Math.floor(timestamp/campaign.period):0; },
    async claim(campaign,receipt,requestedEpoch) {
      const epoch=requestedEpoch??await this.epoch(campaign);
      const batch=campaign.draft.mode==='RETROSPECTIVE'?campaign:await issue(receipt,campaign.policy);
      const result=await prove({receipt,policy:campaign.policy,campaignId:campaign.id,root:batch.root,merkleProof:batch.merkleProof,epoch});
      const nullifier=Buffer.from(result.nullifier,'hex');
      const claimPda=client.claimPda(programId,campaign.id,nullifier);
      if(await connection.getAccountInfo(claimPda))throw new Error('AlreadyClaimed');
      const latest=await connection.getLatestBlockhash('confirmed');
      const transaction=new Transaction({feePayer:payer.publicKey,...latest}).add(client.claim(programId,payer.publicKey,campaign.id,batch.batchId,nullifier,epoch,Buffer.from(result.proof,'hex')));
      transaction.sign(payer);
      const bs58=require('bs58').default || require('bs58');
      const signature=bs58.encode(transaction.signature);
      const raw=transaction.serialize();
      return {transactionHash:signature,epoch:String(epoch),nullifier:result.nullifier,expiresAtBlock:latest.lastValidBlockHeight,
        finalize:async()=>{
          // The API persists this signed transaction's signature before any broadcast.
          // An RPC timeout cannot erase the lookup key of a successful claim.
          try{await connection.sendRawTransaction(raw,{skipPreflight:false,maxRetries:5});}catch(error){ /* Finality lookup, not an ambiguous RPC response, decides settlement. */ }
          for(let attempt=0;attempt<90;attempt++) {
            const status=await connection.getSignatureStatus(signature,{searchTransactionHistory:true});
            if(status.value?.err)throw new Error('claim transaction failed');
            if(!status.value && await connection.getBlockHeight('confirmed')>latest.lastValidBlockHeight)throw new Error('Claim expired before confirmation. Please try again.');
            if(status.value?.confirmationStatus==='finalized') {
              const claim=await connection.getAccountInfo(claimPda,'finalized');
              if(!claim?.owner.equals(programId)||claim.data.readBigUInt64LE(0)!==BigInt(epoch))throw new Error('finalized claim PDA mismatch');
              return {eventKey:`${local?'solana-local':'solana-devnet'}:${signature}:0`,timeSeconds:campaign.draft.claimTimeMinutes*60};
            }
            await new Promise((resolve)=>setTimeout(resolve,2000));
          }
          throw new Error('claim not finalized yet; inspect signature before retrying');
        }};
    },
  };
}
module.exports={createChain};

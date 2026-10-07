const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const local=process.argv.includes('--local');
if(fs.existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
function privateJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});}
function readPrivate(file){if(fs.statSync(file).mode&0o077)throw new Error('Wallet file must be mode 0600');return JSON.parse(fs.readFileSync(file));}
function ui(dir){
  const archive=path.join(root,'demo-ui/copus-ui.tar.gz'); const manifest=JSON.parse(fs.readFileSync(path.join(root,'demo-ui/manifest.json')));
  if(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==manifest.sha256)throw new Error('Copus UI archive checksum mismatch');
  const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});if(listing.status!==0)throw new Error('Cannot inspect Copus UI archive');
  if(listing.stdout.split('\n').some(n=>n.startsWith('/')||n.split('/').includes('..')))throw new Error('Unsafe UI archive entry');
  const out=path.join(dir,'ui',manifest.sha256);if(!fs.existsSync(path.join(out,'index.html'))){fs.mkdirSync(out,{recursive:true});if(spawnSync('tar',['-xzf',archive,'-C',out],{stdio:'inherit'}).status!==0)throw new Error('Cannot extract Copus UI');}
  return out;
}
async function prepare(dir) {
  const {Connection,Keypair,PublicKey,Transaction,sendAndConfirmTransaction}=require('@solana/web3.js');
  const {createMint}=require('@solana/spl-token'); const client=require('./client');
  const rpc=local?(process.env.POE_LOCAL_RPC_URL || 'http://127.0.0.1:8899'):(process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com');
  if(local&&!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/.test(rpc))throw new Error('Local mode requires a loopback RPC URL');
  const connection=new Connection(rpc,{commitment:'confirmed',fetch:require('../services/rpc-network').rpcFetch()});
  if(!local&&await connection.getGenesisHash()!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('Solana Devnet required');
  connection.confirmTransaction=async(strategy)=>{const signature=typeof strategy==='string'?strategy:strategy.signature;for(let i=0;i<90;i++){const result=await connection.getSignatureStatus(signature,{searchTransactionHistory:true});if(result.value?.err)throw new Error('Transaction failed');if(['confirmed','finalized'].includes(result.value?.confirmationStatus))return result;await new Promise(r=>setTimeout(r,2000));}throw new Error('Confirmation unavailable; inspect the signature before retrying');};
  const keyFile=(!local&&process.env.SOLANA_KEYPAIR_PATH) || path.join(dir,'operator.json');
  if(local)delete process.env.POE_PROGRAM_ID;
  if(!fs.existsSync(keyFile))privateJson(keyFile,Array.from(Keypair.generate().secretKey));
  const payer=Keypair.fromSecretKey(Uint8Array.from(readPrivate(keyFile)));
  console.log(`Solana ${local?'local':'Devnet'} operator: ${payer.publicKey}`);
  const programKeyFile=path.join(dir,'program-keypair.json');
  if(!process.env.POE_PROGRAM_ID&&!fs.existsSync(programKeyFile))privateJson(programKeyFile,Array.from(Keypair.generate().secretKey));
  const programId=process.env.POE_PROGRAM_ID?new PublicKey(process.env.POE_PROGRAM_ID):Keypair.fromSecretKey(Uint8Array.from(readPrivate(programKeyFile))).publicKey;
  const deployed=(await connection.getAccountInfo(programId))?.executable;
  const needed=deployed?10000000:3000000000;
  if(await connection.getBalance(payer.publicKey)<needed){
    if(local||!deployed){try{await connection.confirmTransaction(await connection.requestAirdrop(payer.publicKey,local?10000000000:2000000000));}catch{console.log(local?'Local faucet request failed.':'Devnet faucet is rate limited; use the public faucet.');}}
    if(await connection.getBalance(payer.publicKey)<needed)throw new Error(local?'Local faucet did not provide enough SOL':`Add Devnet SOL to ${payer.publicKey} at https://faucet.solana.com, then rerun pnpm demo:product. First deployment needs about 3 Devnet SOL. Wallet: ${keyFile}`);
  }
  if(!deployed){
    const version=spawnSync('solana',['--version'],{encoding:'utf8'});if(version.status!==0)throw new Error('Install the Solana/Agave CLI for the first deployment: https://docs.anza.xyz/cli/install');
    const binary=path.join(root,'program-binary/copus_poe_solana.so');const expected=JSON.parse(fs.readFileSync(path.join(root,'program-binary/manifest.json'))).sha256;
    if(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex')!==expected)throw new Error('Solana program binary checksum mismatch');
    console.log(`Deploying your own isolated ${local?'local':'Devnet'} program.`);
    const result=spawnSync('solana',['program','deploy','--url',rpc,'--keypair',keyFile,'--program-id',programKeyFile,binary],{stdio:'inherit'});if(result.status!==0)throw new Error('Program deployment failed; inspect the CLI output before retrying');
  }
  const config=await connection.getAccountInfo(client.configPda(programId));
  if(config){if(!client.readConfig(config.data).issuer.equals(payer.publicKey))throw new Error('This program requires its authorized issuer. Unset POE_PROGRAM_ID to create your own isolated Devnet program.');}
  else {
    const mint=await createMint(connection,payer,payer.publicKey,null,6);const treasury=Keypair.generate().publicKey;
    await sendAndConfirmTransaction(connection,new Transaction().add(client.initialize(programId,payer.publicKey,payer.publicKey,treasury,mint)),[payer],{commitment:'confirmed'});
  }
  Object.assign(process.env,{POE_PROGRAM_ID:programId.toBase58(),SOLANA_RPC_URL:rpc,SOLANA_KEYPAIR_PATH:keyFile,POE_DEMO_NETWORK:'testnet',POE_DEMO_MINT_TEST_TOKEN:'1',POE_DEMO_CHAIN:local?'solana-local':'solana-devnet'});
}
async function main(){
  if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node.js 22 or newer is required');
  const dir=process.env.POE_REVIEW_DATA || path.join(os.homedir(),local?'.local/share/copus-poe-review/solana-local':'.local/share/copus-poe-review/solana');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  process.env.POE_WEB_ROOT=ui(dir); await prepare(dir);
  const port=process.env.POE_DEMO_PORT || '8792';
  Object.assign(process.env,{POE_DEMO_DATA:process.env.POE_DEMO_DATA||path.join(dir,'ledger'),POE_DEMO_PUBLIC_ORIGIN:`http://localhost:${port}`});
  if(process.env.POE_REVIEW_SETUP_ONLY==='1')return;
  console.log(`Open http://localhost:${port}/time-sponsors?sponsorshipDemo=1`);
  console.log(`Real ${local?'local validator':'Devnet'} transactions; fixture experience data and an isolated TIME ledger. No Copus production API access.`);
  await require('../services/product-demo').main();
}
main().catch(error=>{console.error(error.message);process.exitCode=1});

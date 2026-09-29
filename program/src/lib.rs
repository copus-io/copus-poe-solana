#![allow(unexpected_cfgs)]

use borsh::{BorshDeserialize, BorshSerialize};
use groth16_solana::groth16::Groth16Verifier;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::Instruction,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token::state::{Account as TokenAccount, Mint};

mod verifying_key {
    include!(concat!(env!("OUT_DIR"), "/verifying_key.rs"));
}

const MAX_EVIDENCE_AGE: i64 = 86_400;
const CONFIG_SPACE: usize = 256;
const CAMPAIGN_SPACE: usize = 320;
const BATCH_SPACE: usize = 128;
const CLAIM_SPACE: usize = 16;

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub admin: Pubkey,
    pub issuer: Pubkey,
    pub treasury: Pubkey,
    pub funding_mint: Pubkey,
    pub next_campaign_id: u64,
    pub next_batch_id: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Campaign {
    pub id: u64,
    pub advertiser: Pubkey,
    pub starts_at: i64,
    pub ends_at: i64,
    pub claim_limit: u32,
    pub approved_claims: u32,
    pub time_per_claim_minutes: u32,
    pub claim_period_seconds: u32,
    pub mode: u8, // 0 ongoing, 1 retrospective
    pub rule_hash: [u8; 32],
    pub manifest_hash: [u8; 32],
    pub snapshot_root: [u8; 32],
    pub payment_amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq)]
pub struct Batch {
    pub id: u64,
    pub issuer: Pubkey,
    pub root: [u8; 32],
    pub policy_hash: [u8; 32],
    pub committed_at: i64,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub enum PoEInstruction {
    Initialize {
        issuer: Pubkey,
        treasury: Pubkey,
        funding_mint: Pubkey,
    },
    CommitEvidence {
        root: [u8; 32],
        policy_hash: [u8; 32],
    },
    FundAndActivate {
        payment_amount: u64,
        manifest_hash: [u8; 32],
        rule_hash: [u8; 32],
        snapshot_root: [u8; 32],
        mode: u8,
        starts_at: i64,
        ends_at: i64,
        total_time_minutes: u32,
        time_per_claim_minutes: u32,
        claim_period_seconds: u32,
    },
    Claim {
        batch_id: u64,
        nullifier: [u8; 32],
        epoch: u64,
        proof: [u8; 256],
    },
    SetIssuer {
        issuer: Pubkey,
    },
}

solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    input: &[u8],
) -> ProgramResult {
    match PoEInstruction::try_from_slice(input).map_err(|_| ProgramError::InvalidInstructionData)? {
        PoEInstruction::Initialize {
            issuer,
            treasury,
            funding_mint,
        } => initialize(program_id, accounts, issuer, treasury, funding_mint),
        PoEInstruction::CommitEvidence { root, policy_hash } => {
            commit_evidence(program_id, accounts, root, policy_hash)
        }
        PoEInstruction::FundAndActivate {
            payment_amount,
            manifest_hash,
            rule_hash,
            snapshot_root,
            mode,
            starts_at,
            ends_at,
            total_time_minutes,
            time_per_claim_minutes,
            claim_period_seconds,
        } => fund_and_activate(
            program_id,
            accounts,
            payment_amount,
            manifest_hash,
            rule_hash,
            snapshot_root,
            mode,
            starts_at,
            ends_at,
            total_time_minutes,
            time_per_claim_minutes,
            claim_period_seconds,
        ),
        PoEInstruction::Claim {
            batch_id,
            nullifier,
            epoch,
            proof,
        } => claim(program_id, accounts, batch_id, nullifier, epoch, &proof),
        PoEInstruction::SetIssuer { issuer } => set_issuer(program_id, accounts, issuer),
    }
}

fn err() -> ProgramError {
    ProgramError::InvalidArgument
}
fn require(condition: bool) -> ProgramResult {
    if condition {
        Ok(())
    } else {
        Err(err())
    }
}
fn nonzero(value: &[u8; 32]) -> bool {
    value.iter().any(|&b| b != 0)
}

fn load<T: BorshDeserialize>(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<T, ProgramError> {
    require(account.owner == program_id)?;
    T::deserialize(&mut &account.try_borrow_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)
}

fn save<T: BorshSerialize>(account: &AccountInfo, value: &T) -> ProgramResult {
    let encoded = borsh::to_vec(value).map_err(|_| ProgramError::InvalidAccountData)?;
    let mut data = account.try_borrow_mut_data()?;
    require(encoded.len() <= data.len())?;
    data.fill(0);
    data[..encoded.len()].copy_from_slice(&encoded);
    Ok(())
}

fn create_pda<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    new_account: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    seeds: &[&[u8]],
    space: usize,
) -> ProgramResult {
    require(system.key == &system_program::id() && payer.is_signer && new_account.is_writable)?;
    let (expected, bump) = Pubkey::find_program_address(seeds, program_id);
    require(
        new_account.key == &expected
            && new_account.owner == &system_program::id()
            && new_account.data_is_empty(),
    )?;
    let bump_seed = [bump];
    let mut signer_seeds = seeds.to_vec();
    signer_seeds.push(&bump_seed);
    let rent = Rent::get()?.minimum_balance(space);
    if new_account.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(
                payer.key,
                new_account.key,
                rent,
                space as u64,
                program_id,
            ),
            &[payer.clone(), new_account.clone(), system.clone()],
            &[&signer_seeds],
        )
    } else {
        let extra = rent.saturating_sub(new_account.lamports());
        if extra > 0 {
            invoke(
                &system_instruction::transfer(payer.key, new_account.key, extra),
                &[payer.clone(), new_account.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(new_account.key, space as u64),
            &[new_account.clone(), system.clone()],
            &[&signer_seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(new_account.key, program_id),
            &[new_account.clone(), system.clone()],
            &[&signer_seeds],
        )
    }
}

fn initialize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    issuer: Pubkey,
    treasury: Pubkey,
    mint: Pubkey,
) -> ProgramResult {
    let mut ai = accounts.iter();
    let admin = next_account_info(&mut ai)?;
    let config_account = next_account_info(&mut ai)?;
    let program_data = next_account_info(&mut ai)?;
    let system = next_account_info(&mut ai)?;
    require(
        admin.is_signer
            && issuer != Pubkey::default()
            && treasury != Pubkey::default()
            && mint != Pubkey::default(),
    )?;
    require(
        program_data.key == &bpf_loader_upgradeable::get_program_data_address(program_id)
            && program_data.owner == &bpf_loader_upgradeable::id(),
    )?;
    let data = program_data.try_borrow_data()?;
    let authority = bincode::deserialize::<UpgradeableLoaderState>(
        &data[..data
            .len()
            .min(UpgradeableLoaderState::size_of_programdata_metadata())],
    )
    .map_err(|_| ProgramError::InvalidAccountData)?;
    require(matches!(authority, UpgradeableLoaderState::ProgramData {
        upgrade_authority_address: Some(owner), .. } if owner == *admin.key))?;
    create_pda(
        program_id,
        admin,
        config_account,
        system,
        &[b"config"],
        CONFIG_SPACE,
    )?;
    save(
        config_account,
        &Config {
            admin: *admin.key,
            issuer,
            treasury,
            funding_mint: mint,
            next_campaign_id: 1,
            next_batch_id: 1,
        },
    )
}

fn set_issuer(program_id: &Pubkey, accounts: &[AccountInfo], issuer: Pubkey) -> ProgramResult {
    let mut ai = accounts.iter();
    let admin = next_account_info(&mut ai)?;
    let config_account = next_account_info(&mut ai)?;
    let (config_key, _) = Pubkey::find_program_address(&[b"config"], program_id);
    require(
        admin.is_signer
            && config_account.key == &config_key
            && config_account.is_writable
            && issuer != Pubkey::default(),
    )?;
    let mut config: Config = load(config_account, program_id)?;
    require(config.admin == *admin.key)?;
    config.issuer = issuer;
    save(config_account, &config)
}

fn commit_evidence(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    root: [u8; 32],
    policy_hash: [u8; 32],
) -> ProgramResult {
    let mut ai = accounts.iter();
    let issuer = next_account_info(&mut ai)?;
    let config_account = next_account_info(&mut ai)?;
    let batch_account = next_account_info(&mut ai)?;
    let system = next_account_info(&mut ai)?;
    let (config_key, _) = Pubkey::find_program_address(&[b"config"], program_id);
    require(
        config_account.key == &config_key
            && config_account.is_writable
            && issuer.is_signer
            && nonzero(&root)
            && nonzero(&policy_hash),
    )?;
    let mut config: Config = load(config_account, program_id)?;
    require(issuer.key == &config.issuer)?;
    let id = config.next_batch_id;
    let id_bytes = id.to_le_bytes();
    create_pda(
        program_id,
        issuer,
        batch_account,
        system,
        &[b"batch", &id_bytes],
        BATCH_SPACE,
    )?;
    save(
        batch_account,
        &Batch {
            id,
            issuer: *issuer.key,
            root,
            policy_hash,
            committed_at: Clock::get()?.unix_timestamp,
        },
    )?;
    config.next_batch_id = id.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    save(config_account, &config)?;
    msg!("PoE evidence committed batch={}", id);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn fund_and_activate(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payment_amount: u64,
    manifest_hash: [u8; 32],
    rule_hash: [u8; 32],
    snapshot_root: [u8; 32],
    mode: u8,
    starts_at: i64,
    ends_at: i64,
    total: u32,
    per_claim: u32,
    period: u32,
) -> ProgramResult {
    let mut ai = accounts.iter();
    let advertiser = next_account_info(&mut ai)?;
    let config_account = next_account_info(&mut ai)?;
    let campaign_account = next_account_info(&mut ai)?;
    let advertiser_token = next_account_info(&mut ai)?;
    let treasury_token = next_account_info(&mut ai)?;
    let mint_account = next_account_info(&mut ai)?;
    let token_program = next_account_info(&mut ai)?;
    let system = next_account_info(&mut ai)?;
    let now = Clock::get()?.unix_timestamp;
    let (config_key, _) = Pubkey::find_program_address(&[b"config"], program_id);
    require(
        advertiser.is_signer
            && config_account.key == &config_key
            && config_account.is_writable
            && token_program.key == &spl_token::id()
            && payment_amount > 0
            && nonzero(&manifest_hash)
            && nonzero(&rule_hash)
            && starts_at >= now
            && starts_at >= 0
            && (ends_at == 0 || ends_at > starts_at)
            && total >= 30
            && per_claim >= 30
            && per_claim <= total
            && total.checked_rem(per_claim) == Some(0)
            && (period == 0 || period >= 60)
            && mode <= 1
            && (mode == 0 || nonzero(&snapshot_root)),
    )?;
    let mut config: Config = load(config_account, program_id)?;
    require(mint_account.key == &config.funding_mint && mint_account.owner == token_program.key)?;
    let mint = Mint::unpack(&mint_account.try_borrow_data()?)?;
    require(
        advertiser_token.owner == token_program.key && treasury_token.owner == token_program.key,
    )?;
    let from = TokenAccount::unpack(&advertiser_token.try_borrow_data()?)?;
    let to = TokenAccount::unpack(&treasury_token.try_borrow_data()?)?;
    require(
        from.owner == *advertiser.key
            && from.mint == config.funding_mint
            && to.owner == config.treasury
            && to.mint == config.funding_mint,
    )?;
    let id = config.next_campaign_id;
    let id_bytes = id.to_le_bytes();
    create_pda(
        program_id,
        advertiser,
        campaign_account,
        system,
        &[b"campaign", &id_bytes],
        CAMPAIGN_SPACE,
    )?;
    let transfer: Instruction = spl_token::instruction::transfer_checked(
        token_program.key,
        advertiser_token.key,
        mint_account.key,
        treasury_token.key,
        advertiser.key,
        &[],
        payment_amount,
        mint.decimals,
    )?;
    invoke(
        &transfer,
        &[
            advertiser_token.clone(),
            mint_account.clone(),
            treasury_token.clone(),
            advertiser.clone(),
            token_program.clone(),
        ],
    )?;
    save(
        campaign_account,
        &Campaign {
            id,
            advertiser: *advertiser.key,
            starts_at,
            ends_at,
            claim_limit: total / per_claim,
            approved_claims: 0,
            time_per_claim_minutes: per_claim,
            claim_period_seconds: period,
            mode,
            rule_hash,
            manifest_hash,
            snapshot_root,
            payment_amount,
        },
    )?;
    config.next_campaign_id = id.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    save(config_account, &config)?;
    msg!("PoE campaign funded id={} amount={}", id, payment_amount);
    Ok(())
}

fn claim(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    batch_id: u64,
    nullifier: [u8; 32],
    epoch: u64,
    proof: &[u8; 256],
) -> ProgramResult {
    let mut ai = accounts.iter();
    let payer = next_account_info(&mut ai)?;
    let campaign_account = next_account_info(&mut ai)?;
    let batch_account = next_account_info(&mut ai)?;
    let claim_account = next_account_info(&mut ai)?;
    let system = next_account_info(&mut ai)?;
    require(payer.is_signer && campaign_account.is_writable && nonzero(&nullifier))?;
    let mut campaign: Campaign = load(campaign_account, program_id)?;
    let id_bytes = campaign.id.to_le_bytes();
    let (expected_campaign, _) =
        Pubkey::find_program_address(&[b"campaign", &id_bytes], program_id);
    require(campaign_account.key == &expected_campaign)?;
    let now = Clock::get()?.unix_timestamp;
    require(
        now >= 0
            && now >= campaign.starts_at
            && (campaign.ends_at == 0 || now < campaign.ends_at)
            && campaign.approved_claims < campaign.claim_limit,
    )?;
    let period = campaign.claim_period_seconds as u64;
    if period == 0 {
        require(epoch == 0)?;
    } else {
        let current = (now as u64).checked_div(period).ok_or_else(err)?;
        let first = (campaign.starts_at as u64)
            .checked_div(period)
            .ok_or_else(err)?;
        require(epoch <= current && epoch.saturating_add(1) >= current && epoch >= first)?;
    }
    let root = if campaign.mode == 0 {
        let batch: Batch = load(batch_account, program_id)?;
        let batch_bytes = batch_id.to_le_bytes();
        let (expected_batch, _) =
            Pubkey::find_program_address(&[b"batch", &batch_bytes], program_id);
        require(
            batch_account.key == &expected_batch
                && batch.id == batch_id
                && batch.policy_hash == campaign.rule_hash
                && batch.committed_at <= now
                && now - batch.committed_at <= MAX_EVIDENCE_AGE,
        )?;
        batch.root
    } else {
        campaign.snapshot_root
    };
    let mut public_inputs = [[0u8; 32]; 5];
    public_inputs[0] = root;
    public_inputs[1] = campaign.rule_hash;
    public_inputs[2] = nullifier;
    public_inputs[3][24..].copy_from_slice(&campaign.id.to_be_bytes());
    public_inputs[4][24..].copy_from_slice(&epoch.to_be_bytes());
    let proof_a: &[u8; 64] = proof[0..64].try_into().map_err(|_| err())?;
    let proof_b: &[u8; 128] = proof[64..192].try_into().map_err(|_| err())?;
    let proof_c: &[u8; 64] = proof[192..256].try_into().map_err(|_| err())?;
    let mut verifier = Groth16Verifier::new(
        proof_a,
        proof_b,
        proof_c,
        &public_inputs,
        &verifying_key::VERIFYINGKEY,
    )
    .map_err(|_| err())?;
    verifier.verify().map_err(|_| err())?;
    create_pda(
        program_id,
        payer,
        claim_account,
        system,
        &[b"claim", &id_bytes, &nullifier],
        CLAIM_SPACE,
    )?;
    save(claim_account, &epoch)?;
    campaign.approved_claims = campaign
        .approved_claims
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    save(campaign_account, &campaign)?;
    msg!(
        "PoE sponsorship approved campaign={} batch={} epoch={} claim={}",
        campaign.id,
        batch_id,
        epoch,
        claim_account.key
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_fits_allocations() {
        let config = Config {
            admin: Pubkey::new_unique(),
            issuer: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(),
            funding_mint: Pubkey::new_unique(),
            next_campaign_id: 1,
            next_batch_id: 1,
        };
        assert!(borsh::to_vec(&config).unwrap().len() <= CONFIG_SPACE);
        let campaign = Campaign {
            id: 1,
            advertiser: Pubkey::new_unique(),
            starts_at: 0,
            ends_at: 0,
            claim_limit: 1,
            approved_claims: 0,
            time_per_claim_minutes: 30,
            claim_period_seconds: 0,
            mode: 0,
            rule_hash: [1; 32],
            manifest_hash: [1; 32],
            snapshot_root: [0; 32],
            payment_amount: 1,
        };
        assert!(borsh::to_vec(&campaign).unwrap().len() <= CAMPAIGN_SPACE);
        let batch = Batch {
            id: 1,
            issuer: Pubkey::new_unique(),
            root: [1; 32],
            policy_hash: [1; 32],
            committed_at: 0,
        };
        assert!(borsh::to_vec(&batch).unwrap().len() <= BATCH_SPACE);
    }

    #[test]
    fn key_matches_original_circuit() {
        assert_eq!(verifying_key::VERIFYINGKEY.nr_pubinputs, 5);
        assert_eq!(verifying_key::VERIFYINGKEY.vk_ic.len(), 6);
    }

    #[test]
    fn verifies_real_circom_proof_and_rejects_changed_signal() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../test/proof-fixture.json")).unwrap();
        let proof = hex::decode(fixture["proof"].as_str().unwrap()).unwrap();
        let signals: Vec<[u8; 32]> = fixture["publicSignals"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                hex::decode(v.as_str().unwrap())
                    .unwrap()
                    .try_into()
                    .unwrap()
            })
            .collect();
        let inputs: [[u8; 32]; 5] = signals.try_into().unwrap();
        let a: &[u8; 64] = proof[0..64].try_into().unwrap();
        let b: &[u8; 128] = proof[64..192].try_into().unwrap();
        let c: &[u8; 64] = proof[192..256].try_into().unwrap();
        let mut verifier =
            Groth16Verifier::new(a, b, c, &inputs, &verifying_key::VERIFYINGKEY).unwrap();
        verifier.verify().unwrap();
        let mut changed = inputs;
        changed[3][31] = 2;
        let mut verifier =
            Groth16Verifier::new(a, b, c, &changed, &verifying_key::VERIFYINGKEY).unwrap();
        assert!(verifier.verify().is_err());
    }
}

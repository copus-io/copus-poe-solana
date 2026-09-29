use copus_poe_solana::{process_instruction, PoEInstruction};
use solana_program::program_option::COption;
use solana_program::{
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    program_pack::Pack,
    pubkey::Pubkey,
    rent::Rent,
    system_program,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, Instruction},
    signature::Signer,
    transaction::Transaction,
};
use spl_token::state::{Account as TokenAccount, AccountState, Mint};

fn addr(program: &Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn instruction(
    program_id: Pubkey,
    accounts: Vec<AccountMeta>,
    data: PoEInstruction,
) -> Instruction {
    Instruction {
        program_id,
        accounts,
        data: borsh::to_vec(&data).unwrap(),
    }
}

async fn send(
    ix: Instruction,
    context: &mut ProgramTestContext,
) -> Result<(), solana_program_test::BanksClientError> {
    let recent = context.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&context.payer.pubkey()),
        &[&context.payer],
        recent,
    );
    context.banks_client.process_transaction(tx).await
}

fn bytes32(value: &str) -> [u8; 32] {
    hex::decode(value).unwrap().try_into().unwrap()
}

#[tokio::test]
async fn funds_proves_claims_once_and_rejects_tampering() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../test/proof-fixture.json")).unwrap();
    let root = bytes32(fixture["root"].as_str().unwrap());
    let rule_hash = bytes32(fixture["ruleHash"].as_str().unwrap());
    let nullifier = bytes32(fixture["nullifier"].as_str().unwrap());
    let proof: [u8; 256] = hex::decode(fixture["proof"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let program_id = Pubkey::new_unique();
    let mint_key = Pubkey::new_unique();
    let from_key = Pubkey::new_unique();
    let to_key = Pubkey::new_unique();
    let mut test = if std::env::var_os("POE_TEST_SBF").is_some() {
        ProgramTest::new("copus_poe_solana", program_id, None)
    } else {
        ProgramTest::new(
            "copus_poe_solana",
            program_id,
            processor!(process_instruction),
        )
    };
    test.prefer_bpf(false);
    test.add_program(
        "spl_token",
        spl_token::id(),
        processor!(spl_token::processor::Processor::process),
    );
    let mut context = test.start_with_context().await;
    let payer = context.payer.pubkey();
    let mint = Mint {
        mint_authority: COption::Some(payer),
        supply: 1_000_000,
        decimals: 6,
        is_initialized: true,
        freeze_authority: COption::None,
    };
    let mut mint_data = vec![0u8; Mint::LEN];
    Mint::pack(mint, &mut mint_data).unwrap();
    let from = TokenAccount {
        mint: mint_key,
        owner: payer,
        amount: 1_000_000,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let to = TokenAccount {
        mint: mint_key,
        owner: payer,
        amount: 0,
        ..from
    };
    let mut from_data = vec![0u8; TokenAccount::LEN];
    let mut to_data = vec![0u8; TokenAccount::LEN];
    TokenAccount::pack(from, &mut from_data).unwrap();
    TokenAccount::pack(to, &mut to_data).unwrap();
    // ProgramTest::add_account must happen before start_with_context, so inject
    // the token fixture accounts through the test bank's account store.
    context.set_account(
        &mint_key,
        &Account {
            lamports: Rent::default().minimum_balance(Mint::LEN),
            data: mint_data,
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    context.set_account(
        &from_key,
        &Account {
            lamports: Rent::default().minimum_balance(TokenAccount::LEN),
            data: from_data,
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    context.set_account(
        &to_key,
        &Account {
            lamports: Rent::default().minimum_balance(TokenAccount::LEN),
            data: to_data,
            owner: spl_token::id(),
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    let program_data_key = bpf_loader_upgradeable::get_program_data_address(&program_id);
    let mut program_data = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(payer),
    })
    .unwrap();
    program_data.resize(UpgradeableLoaderState::size_of_programdata_metadata(), 0);
    context.set_account(
        &program_data_key,
        &Account {
            lamports: Rent::default().minimum_balance(program_data.len()),
            data: program_data,
            owner: bpf_loader_upgradeable::id(),
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    let config = addr(&program_id, &[b"config"]);
    let batch = addr(&program_id, &[b"batch", &1u64.to_le_bytes()]);
    let campaign = addr(&program_id, &[b"campaign", &1u64.to_le_bytes()]);
    let claim = addr(&program_id, &[b"claim", &1u64.to_le_bytes(), &nullifier]);
    let init = instruction(
        program_id,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(config, false),
            AccountMeta::new_readonly(program_data_key, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        PoEInstruction::Initialize {
            issuer: payer,
            treasury: payer,
            funding_mint: mint_key,
        },
    );
    send(init, &mut context).await.unwrap();
    let commit = instruction(
        program_id,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(config, false),
            AccountMeta::new(batch, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        PoEInstruction::CommitEvidence {
            root,
            policy_hash: rule_hash,
        },
    );
    send(commit, &mut context).await.unwrap();
    let now = context
        .banks_client
        .get_sysvar::<Clock>()
        .await
        .unwrap()
        .unix_timestamp;
    let fund = instruction(
        program_id,
        vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(config, false),
            AccountMeta::new(campaign, false),
            AccountMeta::new(from_key, false),
            AccountMeta::new(to_key, false),
            AccountMeta::new_readonly(mint_key, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        PoEInstruction::FundAndActivate {
            payment_amount: 1_000,
            manifest_hash: [1; 32],
            rule_hash,
            snapshot_root: [0; 32],
            mode: 0,
            starts_at: now,
            ends_at: 0,
            total_time_minutes: 30,
            time_per_claim_minutes: 30,
            claim_period_seconds: 0,
        },
    );
    send(fund, &mut context).await.unwrap();
    let to_account = context
        .banks_client
        .get_account(to_key)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        TokenAccount::unpack(&to_account.data).unwrap().amount,
        1_000
    );
    let mut bad_proof = proof;
    bad_proof[0] ^= 1;
    let account_metas = vec![
        AccountMeta::new(payer, true),
        AccountMeta::new(campaign, false),
        AccountMeta::new_readonly(batch, false),
        AccountMeta::new(claim, false),
        AccountMeta::new_readonly(system_program::id(), false),
    ];
    let bad = instruction(
        program_id,
        account_metas.clone(),
        PoEInstruction::Claim {
            batch_id: 1,
            nullifier,
            epoch: 0,
            proof: bad_proof,
        },
    );
    assert!(send(bad, &mut context).await.is_err());
    let valid = instruction(
        program_id,
        account_metas.clone(),
        PoEInstruction::Claim {
            batch_id: 1,
            nullifier,
            epoch: 0,
            proof,
        },
    );
    send(valid, &mut context).await.unwrap();
    let repeat = instruction(
        program_id,
        account_metas,
        PoEInstruction::Claim {
            batch_id: 1,
            nullifier,
            epoch: 0,
            proof,
        },
    );
    assert!(send(repeat, &mut context).await.is_err());
}

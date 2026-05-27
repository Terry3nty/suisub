module suisub::subscription {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::event;
    use std::string::{Self, String};

    // Errors
    const EInvalidAmount: u64 = 0;
    const ENotDue: u64 = 1;
    const EUnauthorized: u64 = 2;
    const EInvalidInterval: u64 = 3;
    const EPlanMismatch: u64 = 4;
    const EPlanPaused: u64 = 5;
    const EFeeTooHigh: u64 = 6;
    const EInvalidRetryInterval: u64 = 7;
    const EInvalidMaxFailures: u64 = 8;
    const ESubscriptionPaused: u64 = 9;
    const ESubscriptionCanceled: u64 = 10;
    const EInvalidEscrow: u64 = 11;
    const EInsufficientBalance: u64 = 12;
    const EInvalidSealIdentity: u64 = 13;
    const EContentPlanMismatch: u64 = 14;
    const EAccessDenied: u64 = 15;
    const FEE_BPS_DENOMINATOR: u64 = 10_000;
    const PROTOCOL_FEE_BPS: u64 = 100; // 1%
    const PROTOCOL_FIXED_FEE: u64 = 0;
    const PROTOCOL_TREASURY: address = @0x22fd3509cc3dbfa80d890d79a496ddb3f9d81df6495a8f65bd2317bfeb3136cd;
    const STATUS_ACTIVE: u8 = 0;
    const STATUS_PAST_DUE: u8 = 1;
    const STATUS_PAUSED: u8 = 2;
    const STATUS_CANCELED: u8 = 3;

    // Events
    public struct SubscriptionCreated has copy, drop {
        subscriber: address,
        plan_id: ID,
        subscription_id: ID,
        escrow_id: ID,
        escrow_balance: u64,
        next_due: u64,
        grace_until: u64,
        status: u8,
    }

    public struct EscrowCreated has copy, drop {
        escrow_id: ID,
        owner: address,
        balance: u64,
    }

    public struct EscrowToppedUp has copy, drop {
        escrow_id: ID,
        owner: address,
        amount: u64,
        balance: u64,
    }

    public struct EscrowWithdrawn has copy, drop {
        escrow_id: ID,
        owner: address,
        amount: u64,
        balance: u64,
    }

    public struct PlanCreated has copy, drop {
        plan_id: ID,
        merchant: address,
        price: u64,
        interval_ms: u64,
        grace_period_ms: u64,
        retry_interval_ms: u64,
        max_failures: u64,
        active: bool,
    }

    public struct PlanPaused has copy, drop {
        plan_id: ID,
        merchant: address,
    }

    public struct PaymentExecuted has copy, drop {
        subscription_id: ID,
        amount: u64,
        protocol_fee: u64,
        merchant: address,
    }

    public struct PaymentFailed has copy, drop {
        subscription_id: ID,
        amount: u64,
        escrow_balance: u64,
        failed_attempts: u64,
        next_due: u64,
        grace_until: u64,
        status: u8,
    }

    public struct SubscriptionCanceled has copy, drop {
        subscription_id: ID,
        subscriber: address,
    }

    public struct SubscriptionResumed has copy, drop {
        subscription_id: ID,
        subscriber: address,
    }

    public struct ContentPublished has copy, drop {
        content_id: ID,
        creator: address,
        plan_id: ID,
        walrus_blob_id: String,
        walrus_object_id: String,
        seal_id: vector<u8>,
        content_type: String,
    }

    fun calculate_protocol_fee(amount: u64): u64 {
        let percent_fee = ((((amount as u128) * (PROTOCOL_FEE_BPS as u128)) / (FEE_BPS_DENOMINATOR as u128)) as u64);
        let total = (percent_fee as u128) + (PROTOCOL_FIXED_FEE as u128);
        (total as u64)
    }

    // ── Subscription Plan (owned by merchant) ──
    public struct SubscriptionPlan<phantom CoinType> has key {
        id: UID,
        merchant: address,
        name: String,
        price: u64,
        interval_ms: u64,
        grace_period_ms: u64,
        retry_interval_ms: u64,
        max_failures: u64,
        active: bool,
    }

    // ── Subscriber Escrow (shared – keeper can debit) ──
    public struct EscrowVault<phantom CoinType> has key {
        id: UID,
        owner: address,
        balance: Balance<CoinType>,
    }

    // ── Subscription (shared object – keeper can mutate) ──
    public struct Subscription<phantom CoinType> has key {
        id: UID,
        plan_id: ID,
        escrow_id: ID,
        subscriber: address,
        merchant: address,
        last_paid: u64,
        next_due: u64,
        grace_until: u64,
        failed_attempts: u64,
        status: u8,
    }

    // ── Creator content metadata for Walrus + SEAL gated content ──
    public struct GatedContent has key {
        id: UID,
        creator: address,
        plan_id: ID,
        walrus_blob_id: String,
        walrus_object_id: String,
        seal_id: vector<u8>,
        content_type: String,
    }

    // ── Create a new subscription plan ──
    public fun create_plan<CoinType>(
        name: vector<u8>,
        price: u64,
        interval_ms: u64,
        ctx: &mut TxContext
    ) {
        assert!(price > 0, EInvalidAmount);
        assert!(interval_ms > 0, EInvalidInterval);
        let fee = calculate_protocol_fee(price);
        assert!(fee < price, EFeeTooHigh);
        let merchant = tx_context::sender(ctx);
        let plan = SubscriptionPlan<CoinType> {
            id: object::new(ctx),
            merchant,
            name: string::utf8(name),
            price,
            interval_ms,
            grace_period_ms: 259_200_000, // 3 days
            retry_interval_ms: 43_200_000, // 12 hours
            max_failures: 3,
            active: true,
        };
        event::emit(PlanCreated {
            plan_id: object::id(&plan),
            merchant,
            price,
            interval_ms,
            grace_period_ms: 259_200_000,
            retry_interval_ms: 43_200_000,
            max_failures: 3,
            active: true,
        });
        transfer::share_object(plan);
    }

    public fun pause_plan<CoinType>(
        plan: &mut SubscriptionPlan<CoinType>,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == plan.merchant, EUnauthorized);
        plan.active = false;
        event::emit(PlanPaused {
            plan_id: object::id(plan),
            merchant: plan.merchant,
        });
    }

    // ── Create escrow vault (subscriber) ──
    public fun create_escrow<CoinType>(
        initial_deposit: Coin<CoinType>,
        ctx: &mut TxContext
    ) {
        let owner = tx_context::sender(ctx);
        let amount = coin::value(&initial_deposit);
        assert!(amount > 0, EInvalidAmount);
        let escrow = EscrowVault<CoinType> {
            id: object::new(ctx),
            owner,
            balance: coin::into_balance(initial_deposit),
        };
        event::emit(EscrowCreated {
            escrow_id: object::id(&escrow),
            owner,
            balance: amount,
        });
        transfer::share_object(escrow);
    }

    // ── Top up escrow balance ──
    public fun top_up_escrow<CoinType>(
        escrow: &mut EscrowVault<CoinType>,
        top_up_coin: Coin<CoinType>,
        ctx: &TxContext
    ) {
        assert!(tx_context::sender(ctx) == escrow.owner, EUnauthorized);
        let amount = coin::value(&top_up_coin);
        assert!(amount > 0, EInvalidAmount);
        let added = coin::into_balance(top_up_coin);
        balance::join(&mut escrow.balance, added);
        event::emit(EscrowToppedUp {
            escrow_id: object::id(escrow),
            owner: escrow.owner,
            amount,
            balance: balance::value(&escrow.balance),
        });
    }

    // ── Withdraw from escrow (subscriber only) ──
    public fun withdraw_escrow<CoinType>(
        escrow: &mut EscrowVault<CoinType>,
        amount: u64,
        ctx: &mut TxContext
    ) {
        assert!(tx_context::sender(ctx) == escrow.owner, EUnauthorized);
        assert!(amount > 0, EInvalidAmount);
        let current = balance::value(&escrow.balance);
        assert!(amount <= current, EInsufficientBalance);
        let withdrawn = balance::split(&mut escrow.balance, amount);
        transfer::public_transfer(coin::from_balance(withdrawn, ctx), escrow.owner);
        event::emit(EscrowWithdrawn {
            escrow_id: object::id(escrow),
            owner: escrow.owner,
            amount,
            balance: current - amount,
        });
    }

    // ── Subscribe + pre-fund escrow (keeper executes first payment) ──
    public fun subscribe<CoinType>(
        plan: &SubscriptionPlan<CoinType>,
        initial_deposit: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(plan.active, EPlanPaused);
        assert!(plan.interval_ms > 0, EInvalidInterval);
        assert!(plan.retry_interval_ms > 0, EInvalidRetryInterval);
        assert!(plan.max_failures > 0, EInvalidMaxFailures);
        let escrow_balance = coin::value(&initial_deposit);
        assert!(escrow_balance >= plan.price, EInsufficientBalance);
        let escrow = EscrowVault<CoinType> {
            id: object::new(ctx),
            owner: sender,
            balance: coin::into_balance(initial_deposit),
        };
        let escrow_id = object::id(&escrow);

        let now = clock::timestamp_ms(clock);

        let sub = Subscription<CoinType> {
            id: object::new(ctx),
            plan_id: object::id(plan),
            escrow_id,
            subscriber: sender,
            merchant: plan.merchant,
            last_paid: 0,
            next_due: now,
            grace_until: now + plan.grace_period_ms,
            failed_attempts: 0,
            status: STATUS_ACTIVE,
        };

        let sub_id = object::id(&sub);
        let next_due = sub.next_due;
        let grace_until = sub.grace_until;
        let status = sub.status;
        transfer::share_object(escrow);
        transfer::share_object(sub);

        event::emit(EscrowCreated {
            escrow_id,
            owner: sender,
            balance: escrow_balance,
        });
        event::emit(SubscriptionCreated {
            subscriber: sender,
            plan_id: object::id(plan),
            subscription_id: sub_id,
            escrow_id,
            escrow_balance,
            next_due,
            grace_until,
            status,
        });
    }

    // ── Register encrypted creator content stored on Walrus ──
    public fun publish_content<CoinType>(
        plan: &SubscriptionPlan<CoinType>,
        walrus_blob_id: vector<u8>,
        walrus_object_id: vector<u8>,
        seal_id: vector<u8>,
        content_type: vector<u8>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == plan.merchant, EUnauthorized);
        assert!(vector::length(&seal_id) > 0, EInvalidSealIdentity);

        let content = GatedContent {
            id: object::new(ctx),
            creator: sender,
            plan_id: object::id(plan),
            walrus_blob_id: string::utf8(walrus_blob_id),
            walrus_object_id: string::utf8(walrus_object_id),
            seal_id,
            content_type: string::utf8(content_type),
        };
        event::emit(ContentPublished {
            content_id: object::id(&content),
            creator: sender,
            plan_id: object::id(plan),
            walrus_blob_id: content.walrus_blob_id,
            walrus_object_id: content.walrus_object_id,
            seal_id: content.seal_id,
            content_type: content.content_type,
        });
        transfer::share_object(content);
    }

    // SEAL key servers dry-run this policy before returning decryption keys.
    entry fun seal_approve_subscription<CoinType>(
        id: vector<u8>,
        content: &GatedContent,
        sub: &Subscription<CoinType>,
        clock: &Clock,
        ctx: &TxContext
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(id == content.seal_id, EInvalidSealIdentity);
        assert!(sub.plan_id == content.plan_id, EContentPlanMismatch);
        assert!(tx_context::sender(ctx) == sub.subscriber, EUnauthorized);
        assert!(sub.status == STATUS_ACTIVE, EAccessDenied);
        assert!(now <= sub.grace_until, EAccessDenied);
    }

    // ── Keeper calls this when payment is due (handles retries + grace) ──
    public fun execute_payment<CoinType>(
        sub: &mut Subscription<CoinType>,
        plan: &SubscriptionPlan<CoinType>,
        escrow: &mut EscrowVault<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(sub.status != STATUS_CANCELED, ESubscriptionCanceled);
        assert!(sub.status != STATUS_PAUSED, ESubscriptionPaused);
        assert!(object::id(plan) == sub.plan_id, EPlanMismatch);
        assert!(plan.merchant == sub.merchant, EPlanMismatch);
        assert!(plan.active, EPlanPaused);
        assert!(object::id(escrow) == sub.escrow_id, EInvalidEscrow);
        assert!(escrow.owner == sub.subscriber, EInvalidEscrow);
        assert!(plan.interval_ms > 0, EInvalidInterval);
        assert!(plan.retry_interval_ms > 0, EInvalidRetryInterval);
        assert!(plan.max_failures > 0, EInvalidMaxFailures);
        assert!(now >= sub.next_due, ENotDue);
        let balance_value = balance::value(&escrow.balance);
        if (balance_value < plan.price) {
            sub.failed_attempts = sub.failed_attempts + 1;
            let grace_expired = now > sub.grace_until;
            let exceeded_failures = sub.failed_attempts >= plan.max_failures;
            if (grace_expired || exceeded_failures) {
                sub.status = STATUS_PAUSED;
            } else {
                sub.status = STATUS_PAST_DUE;
            };
            sub.next_due = now + plan.retry_interval_ms;
            event::emit(PaymentFailed {
                subscription_id: object::id(sub),
                amount: plan.price,
                escrow_balance: balance_value,
                failed_attempts: sub.failed_attempts,
                next_due: sub.next_due,
                grace_until: sub.grace_until,
                status: sub.status,
            });
        } else {
            let protocol_fee = calculate_protocol_fee(plan.price);
            assert!(protocol_fee < plan.price, EFeeTooHigh);

            let mut paid = balance::split(&mut escrow.balance, plan.price);
            let fee_balance = balance::split(&mut paid, protocol_fee);
            transfer::public_transfer(coin::from_balance(fee_balance, ctx), PROTOCOL_TREASURY);
            transfer::public_transfer(coin::from_balance(paid, ctx), sub.merchant);

            sub.last_paid = now;
            sub.next_due = now + plan.interval_ms;
            sub.grace_until = sub.next_due + plan.grace_period_ms;
            sub.failed_attempts = 0;
            sub.status = STATUS_ACTIVE;

            event::emit(PaymentExecuted {
                subscription_id: object::id(sub),
                amount: plan.price,
                protocol_fee,
                merchant: sub.merchant,
            });
        }
    }

    public fun resume<CoinType>(
        sub: &mut Subscription<CoinType>,
        plan: &SubscriptionPlan<CoinType>,
        clock: &Clock,
        ctx: &TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == sub.subscriber, EUnauthorized);
        assert!(sub.status == STATUS_PAUSED, ESubscriptionPaused);
        assert!(object::id(plan) == sub.plan_id, EPlanMismatch);
        assert!(plan.merchant == sub.merchant, EPlanMismatch);
        assert!(plan.active, EPlanPaused);
        let now = clock::timestamp_ms(clock);
        sub.status = STATUS_PAST_DUE;
        sub.failed_attempts = 0;
        sub.next_due = now;
        sub.grace_until = now + plan.grace_period_ms;
        event::emit(SubscriptionResumed {
            subscription_id: object::id(sub),
            subscriber: sub.subscriber,
        });
    }

    // ── Cancel anytime (subscriber only) ──
    public fun cancel<CoinType>(
        sub: &mut Subscription<CoinType>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == sub.subscriber, EUnauthorized);
        assert!(sub.status != STATUS_CANCELED, ESubscriptionCanceled);

        sub.status = STATUS_CANCELED;

        event::emit(SubscriptionCanceled {
            subscription_id: object::id(sub),
            subscriber: sub.subscriber,
        });
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EInvalidAmount)]
    fun test_create_plan_rejects_zero_price() {
        let mut ctx = tx_context::dummy();
        create_plan<0x2::sui::SUI>(b"plan", 0, 86_400_000, &mut ctx);
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EInvalidInterval)]
    fun test_create_plan_rejects_zero_interval() {
        let mut ctx = tx_context::dummy();
        create_plan<0x2::sui::SUI>(b"plan", 1_000_000_000, 0, &mut ctx);
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EInsufficientBalance)]
    fun test_subscribe_rejects_insufficient_escrow_balance() {
        let mut ctx = tx_context::dummy();
        let plan = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xA,
            name: string::utf8(b"plan"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 1_000,
            retry_interval_ms: 500,
            max_failures: 3,
            active: true,
        };
        let deposit = coin::mint_for_testing<0x2::sui::SUI>(99, &mut ctx);
        let clock = clock::create_for_testing(&mut ctx);
        subscribe(&plan, deposit, &clock, &mut ctx);
        clock.destroy_for_testing();
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EInsufficientBalance)]
    fun test_withdraw_rejects_insufficient_balance() {
        let mut ctx = tx_context::dummy();
        let mut escrow = EscrowVault<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            owner: tx_context::sender(&ctx),
            balance: balance::create_for_testing(10),
        };
        withdraw_escrow(&mut escrow, 11, &mut ctx);
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EPlanMismatch)]
    fun test_execute_payment_rejects_plan_mismatch() {
        let mut ctx = tx_context::dummy();
        let plan_a = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xB,
            name: string::utf8(b"a"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 1_000,
            retry_interval_ms: 500,
            max_failures: 3,
            active: true,
        };
        let plan_b = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xB,
            name: string::utf8(b"b"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 1_000,
            retry_interval_ms: 500,
            max_failures: 3,
            active: true,
        };
        let mut escrow = EscrowVault<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            owner: tx_context::sender(&ctx),
            balance: balance::create_for_testing(500),
        };
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: object::id(&plan_a),
            escrow_id: object::id(&escrow),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            last_paid: 0,
            next_due: 0,
            grace_until: 1_000,
            failed_attempts: 0,
            status: STATUS_ACTIVE,
        };
        let mut clock = clock::create_for_testing(&mut ctx);
        clock.set_for_testing(1);
        execute_payment(&mut sub, &plan_b, &mut escrow, &clock, &mut ctx);
        clock.destroy_for_testing();
        abort 0
    }

    #[test]
    fun test_execute_payment_records_failure_and_retries() {
        let mut ctx = tx_context::dummy();
        let plan = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xB,
            name: string::utf8(b"a"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 10_000,
            retry_interval_ms: 500,
            max_failures: 3,
            active: true,
        };
        let mut escrow = EscrowVault<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            owner: tx_context::sender(&ctx),
            balance: balance::create_for_testing(0),
        };
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: object::id(&plan),
            escrow_id: object::id(&escrow),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            last_paid: 0,
            next_due: 0,
            grace_until: 10_000,
            failed_attempts: 0,
            status: STATUS_ACTIVE,
        };
        let mut clock = clock::create_for_testing(&mut ctx);
        clock.set_for_testing(10);
        execute_payment(&mut sub, &plan, &mut escrow, &clock, &mut ctx);
        assert!(sub.failed_attempts == 1, 0);
        assert!(sub.status == STATUS_PAST_DUE, 1);
        assert!(sub.next_due == 510, 2);
        clock.destroy_for_testing();
        transfer::transfer(sub, tx_context::sender(&ctx));
        transfer::transfer(escrow, tx_context::sender(&ctx));
        transfer::transfer(plan, tx_context::sender(&ctx));
    }

    #[test]
    fun test_execute_payment_pauses_after_max_failures() {
        let mut ctx = tx_context::dummy();
        let plan = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xB,
            name: string::utf8(b"a"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 10_000,
            retry_interval_ms: 500,
            max_failures: 1,
            active: true,
        };
        let mut escrow = EscrowVault<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            owner: tx_context::sender(&ctx),
            balance: balance::create_for_testing(0),
        };
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: object::id(&plan),
            escrow_id: object::id(&escrow),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            last_paid: 0,
            next_due: 0,
            grace_until: 10_000,
            failed_attempts: 0,
            status: STATUS_ACTIVE,
        };
        let mut clock = clock::create_for_testing(&mut ctx);
        clock.set_for_testing(10);
        execute_payment(&mut sub, &plan, &mut escrow, &clock, &mut ctx);
        assert!(sub.status == STATUS_PAUSED, 0);
        assert!(sub.failed_attempts == 1, 1);
        clock.destroy_for_testing();
        transfer::transfer(sub, tx_context::sender(&ctx));
        transfer::transfer(escrow, tx_context::sender(&ctx));
        transfer::transfer(plan, tx_context::sender(&ctx));
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::ESubscriptionCanceled)]
    fun test_cancel_rejects_canceled_subscription() {
        let mut ctx = tx_context::dummy();
        let fake_plan_uid = object::new(&mut ctx);
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: fake_plan_uid.to_inner(),
            escrow_id: fake_plan_uid.to_inner(),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            last_paid: 0,
            next_due: 0,
            grace_until: 0,
            failed_attempts: 0,
            status: STATUS_CANCELED,
        };
        fake_plan_uid.delete();
        cancel(&mut sub, &mut ctx);
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EPlanPaused)]
    fun test_subscribe_rejects_paused_plan() {
        let mut ctx = tx_context::dummy();
        let plan = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xA,
            name: string::utf8(b"plan"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 1_000,
            retry_interval_ms: 500,
            max_failures: 3,
            active: false,
        };
        let deposit = coin::mint_for_testing<0x2::sui::SUI>(100, &mut ctx);
        let clock = clock::create_for_testing(&mut ctx);
        subscribe(&plan, deposit, &clock, &mut ctx);
        clock.destroy_for_testing();
        abort 0
    }

    #[test]
    fun test_pause_plan_sets_inactive() {
        let mut ctx = tx_context::dummy();
        let mut plan = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: tx_context::sender(&ctx),
            name: string::utf8(b"plan"),
            price: 100,
            interval_ms: 1_000,
            grace_period_ms: 1_000,
            retry_interval_ms: 500,
            max_failures: 3,
            active: true,
        };
        pause_plan(&mut plan, &ctx);
        assert!(!plan.active, 0);
        transfer::transfer(plan, tx_context::sender(&ctx));
    }
}

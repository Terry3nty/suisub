module suisub::subscription {
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::event;
    use std::string::{Self, String};

    // Errors
    const EInvalidAmount: u64 = 0;
    const ENotDue: u64 = 1;
    const ENotActive: u64 = 2;
    const EUnauthorized: u64 = 3;
    const EInvalidInterval: u64 = 4;
    const EPlanMismatch: u64 = 5;
    const EPlanPaused: u64 = 6;
    const EFeeTooHigh: u64 = 7;
    const FEE_BPS_DENOMINATOR: u64 = 10_000;
    const PROTOCOL_FEE_BPS: u64 = 100; // 1%
    const PROTOCOL_FIXED_FEE_MIST: u64 = 5_000_000; // 0.005 SUI
    const PROTOCOL_TREASURY: address = @0x22fd3509cc3dbfa80d890d79a496ddb3f9d81df6495a8f65bd2317bfeb3136cd;

    // Events
    public struct SubscriptionCreated has copy, drop {
        subscriber: address,
        plan_id: ID,
        subscription_id: ID,
    }

    public struct PlanCreated has copy, drop {
        plan_id: ID,
        merchant: address,
        price: u64,
        interval_ms: u64,
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

    public struct SubscriptionCanceled has copy, drop {
        subscription_id: ID,
        subscriber: address,
    }

    fun calculate_protocol_fee(amount: u64): u64 {
        let percent_fee = ((((amount as u128) * (PROTOCOL_FEE_BPS as u128)) / (FEE_BPS_DENOMINATOR as u128)) as u64);
        let total = (percent_fee as u128) + (PROTOCOL_FIXED_FEE_MIST as u128);
        (total as u64)
    }

    // ── Subscription Plan (owned by merchant) ──
    public struct SubscriptionPlan<phantom CoinType> has key {
        id: UID,
        merchant: address,
        name: String,
        price: u64,
        interval_ms: u64,
        active: bool,
    }

    // ── Subscription (shared object – keeper can mutate) ──
    public struct Subscription<phantom CoinType> has key {
        id: UID,
        plan_id: ID,
        subscriber: address,
        merchant: address,
        balance: Balance<CoinType>,
        last_paid: u64,
        next_due: u64,
        active: bool,
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
            active: true,
        };
        event::emit(PlanCreated {
            plan_id: object::id(&plan),
            merchant,
            price,
            interval_ms,
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

    // ── Subscribe + pay first installment + pre-fund escrow ──
    public fun subscribe<CoinType>(
        plan: &SubscriptionPlan<CoinType>,
        first_payment: Coin<CoinType>,
        escrow_deposit: Coin<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(plan.active, EPlanPaused);
        assert!(plan.interval_ms > 0, EInvalidInterval);
        assert!(coin::value(&first_payment) == plan.price, EInvalidAmount);
        let protocol_fee = calculate_protocol_fee(plan.price);
        assert!(protocol_fee < plan.price, EFeeTooHigh);

        // Split first payment into protocol fee + merchant payout.
        let mut first_payment_balance = coin::into_balance(first_payment);
        let fee_balance = balance::split(&mut first_payment_balance, protocol_fee);
        transfer::public_transfer(coin::from_balance(fee_balance, ctx), PROTOCOL_TREASURY);
        transfer::public_transfer(coin::from_balance(first_payment_balance, ctx), plan.merchant);

        let now = clock::timestamp_ms(clock);

        let sub = Subscription<CoinType> {
            id: object::new(ctx),
            plan_id: object::id(plan),
            subscriber: sender,
            merchant: plan.merchant,
            balance: coin::into_balance(escrow_deposit),
            last_paid: now,
            next_due: now + plan.interval_ms,
            active: true,
        };

        let sub_id = object::id(&sub);
        transfer::share_object(sub);

        event::emit(SubscriptionCreated {
            subscriber: sender,
            plan_id: object::id(plan),
            subscription_id: sub_id,
        });
    }

    // ── Top up escrow balance ──
    public fun top_up<CoinType>(
        sub: &mut Subscription<CoinType>,
        top_up_coin: Coin<CoinType>,
        _ctx: &mut TxContext
    ) {
        assert!(sub.active, ENotActive);
        let added = coin::into_balance(top_up_coin);
        balance::join(&mut sub.balance, added);
    }

    // ── Keeper calls this when payment is due ──
    public fun execute_payment<CoinType>(
        sub: &mut Subscription<CoinType>,
        plan: &SubscriptionPlan<CoinType>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(sub.active, ENotActive);
        assert!(object::id(plan) == sub.plan_id, EPlanMismatch);
        assert!(plan.merchant == sub.merchant, EPlanMismatch);
        assert!(plan.active, EPlanPaused);
        assert!(plan.interval_ms > 0, EInvalidInterval);
        assert!(now >= sub.next_due, ENotDue);
        assert!(balance::value(&sub.balance) >= plan.price, EInvalidAmount);
        let protocol_fee = calculate_protocol_fee(plan.price);
        assert!(protocol_fee < plan.price, EFeeTooHigh);

        let mut paid = balance::split(&mut sub.balance, plan.price);
        let fee_balance = balance::split(&mut paid, protocol_fee);
        transfer::public_transfer(coin::from_balance(fee_balance, ctx), PROTOCOL_TREASURY);
        transfer::public_transfer(coin::from_balance(paid, ctx), sub.merchant);

        sub.last_paid = now;
        sub.next_due = now + plan.interval_ms;

        event::emit(PaymentExecuted {
            subscription_id: object::id(sub),
            amount: plan.price,
            protocol_fee,
            merchant: sub.merchant,
        });
    }

    // ── Cancel anytime (subscriber only) + refund remaining balance ──
    public fun cancel<CoinType>(
        sub: &mut Subscription<CoinType>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == sub.subscriber, EUnauthorized);
        assert!(sub.active, ENotActive);

        sub.active = false;

        if (balance::value(&sub.balance) > 0) {
            let remaining = balance::withdraw_all(&mut sub.balance);
            let coin_rem = coin::from_balance(remaining, ctx);
            transfer::public_transfer(coin_rem, sub.subscriber);
        };

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

    #[test, expected_failure(abort_code = ::suisub::subscription::EFeeTooHigh)]
    fun test_create_plan_rejects_too_small_price_for_fee() {
        let mut ctx = tx_context::dummy();
        create_plan<0x2::sui::SUI>(b"plan", 1_000_000, 86_400_000, &mut ctx);
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::EInvalidAmount)]
    fun test_subscribe_rejects_wrong_first_payment() {
        let mut ctx = tx_context::dummy();
        let plan = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xA,
            name: string::utf8(b"plan"),
            price: 100,
            interval_ms: 1_000,
            active: true,
        };
        let first_payment = coin::mint_for_testing<0x2::sui::SUI>(99, &mut ctx);
        let escrow = coin::mint_for_testing<0x2::sui::SUI>(100, &mut ctx);
        let clock = clock::create_for_testing(&mut ctx);
        subscribe(&plan, first_payment, escrow, &clock, &mut ctx);
        clock.destroy_for_testing();
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::ENotActive)]
    fun test_top_up_rejects_inactive_subscription() {
        let mut ctx = tx_context::dummy();
        let fake_plan_uid = object::new(&mut ctx);
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: fake_plan_uid.to_inner(),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            balance: balance::create_for_testing(0),
            last_paid: 0,
            next_due: 0,
            active: false,
        };
        fake_plan_uid.delete();
        let top_up_coin = coin::mint_for_testing<0x2::sui::SUI>(100, &mut ctx);
        top_up(&mut sub, top_up_coin, &mut ctx);
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
            active: true,
        };
        let plan_b = SubscriptionPlan<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            merchant: @0xB,
            name: string::utf8(b"b"),
            price: 100,
            interval_ms: 1_000,
            active: true,
        };
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: object::id(&plan_a),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            balance: balance::create_for_testing(500),
            last_paid: 0,
            next_due: 0,
            active: true,
        };
        let mut clock = clock::create_for_testing(&mut ctx);
        clock.set_for_testing(1);
        execute_payment(&mut sub, &plan_b, &clock, &mut ctx);
        clock.destroy_for_testing();
        abort 0
    }

    #[test, expected_failure(abort_code = ::suisub::subscription::ENotActive)]
    fun test_cancel_rejects_inactive_subscription() {
        let mut ctx = tx_context::dummy();
        let fake_plan_uid = object::new(&mut ctx);
        let mut sub = Subscription<0x2::sui::SUI> {
            id: object::new(&mut ctx),
            plan_id: fake_plan_uid.to_inner(),
            subscriber: tx_context::sender(&ctx),
            merchant: @0xB,
            balance: balance::create_for_testing(0),
            last_paid: 0,
            next_due: 0,
            active: false,
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
            active: false,
        };
        let first_payment = coin::mint_for_testing<0x2::sui::SUI>(100, &mut ctx);
        let escrow = coin::mint_for_testing<0x2::sui::SUI>(100, &mut ctx);
        let clock = clock::create_for_testing(&mut ctx);
        subscribe(&plan, first_payment, escrow, &clock, &mut ctx);
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
            active: true,
        };
        pause_plan(&mut plan, &ctx);
        assert!(!plan.active, 0);
        transfer::transfer(plan, tx_context::sender(&ctx));
    }
}

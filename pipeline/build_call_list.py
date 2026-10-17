#!/usr/bin/env python3
"""
SIP Rescue - nightly call-list builder (prototype).

Run at ~19:00 IST on RUN_DATE. Produces one row per user who has a SIP debit
due tomorrow, with their latest known bank balance (from bank SMS), their
insufficient-funds history, and the decision: NO_CALL / INFO_CALL / CONVERSATION_CALL.

Usage:
    python3 pipeline/build_call_list.py --run-date 2026-10-14 --data buildathon-data --out pipeline/out

Data sources (hackathon CSVs):
    investment/sip_plans.csv   -> which plans are ACTIVE and when they debit
    investment/orders.csv      -> INITIATED orders today (= debit tomorrow) + failure history
    sms/sms.csv                -> bank balance alerts + "bachatt" mandate SMS (links mandate -> bank a/c)
    loan/customers.csv         -> name + mobile for the call
"""
import argparse, io, re, sys
from datetime import datetime, timedelta
import pandas as pd
import warnings
warnings.simplefilter('ignore', FutureWarning)

# ----------------------------------------------------------------------------- config
BALANCE_FRESH_HOURS = 72          # balance older than this is "stale" -> low confidence
BUFFER_INR = 20                   # keep a small cushion above the debit amount
MIN_BALANCE_FLOOR_INR = 500       # savings-account minimum balance banks hold back; replace with a per-bank table
INFO_COOLDOWN_DAYS = 2            # don't info-call the same user more often than this (needs call log)
CONV_COOLDOWN_DAYS = 7            # don't conversation-call the same user more often than this
TELCO_WORDS = re.compile(r'airtel|jio|vi |vodafone|pack|data bal|talktime|recharge|validity', re.I)

BAL_RE = re.compile(
    r'(?:avl\.?\s*bal|available\s+balance|avail(?:able)?\s*bal|avlbl\s*amt|total\s*bal|clear\s*bal|bal(?:ance)?)'
    r'\s*(?:is|:|-)?\s*(?:INR|Rs\.?|₹)?\s*:?\s*([\d,]+\.?\d*)', re.I)
ACCT_RE = re.compile(r'(?:a/c|account|ac)\s*(?:no\.?)?\s*[:#]?\s*[xX\*\.]*(\d{3,6})', re.I)


# ----------------------------------------------------------------------------- loaders
def load_sms(path):
    raw = open(path, 'rb').read().replace(b'\x00', b'').decode('utf-8', 'replace')
    sms = pd.read_csv(io.StringIO(raw), dtype=str, keep_default_na=False)
    sms = sms[sms.user_id.str.match(r'^\d{10,}$')].copy()        # drop rows broken by multiline bodies
    sms['ts'] = pd.to_datetime(sms.received_at_ist, errors='coerce')
    return sms.dropna(subset=['ts'])


def parse_balances(sms):
    """One row per SMS that states an account balance."""
    rows = []
    for r in sms.itertuples():
        if TELCO_WORDS.search(r.body_text):
            continue
        m = BAL_RE.search(r.body_text)
        if not m:
            continue
        try:
            bal = float(m.group(1).replace(',', ''))
        except ValueError:
            continue
        a = ACCT_RE.search(r.body_text)
        rows.append((r.user_id, r.sender, r.ts, bal, a.group(1)[-4:] if a else None))
    return pd.DataFrame(rows, columns=['user_id', 'sender', 'ts', 'balance', 'acct'])


def mandate_accounts(sms):
    """user_id -> bank a/c last-4 that the Bachatt UPI AutoPay mandate debits (from mandate SMS)."""
    bm = sms[sms.body_text.str.contains('bachatt', case=False)]
    out = {}
    for r in bm.itertuples():
        a = ACCT_RE.search(r.body_text)
        if a:
            out.setdefault(r.user_id, {}).setdefault(a.group(1)[-4:], 0)
            out[r.user_id][a.group(1)[-4:]] += 1
    return {u: max(d, key=d.get) for u, d in out.items()}


# ----------------------------------------------------------------------------- signals
def upcoming_debits(orders, plans, run_date):
    """Plans that will debit tomorrow.
    Primary: SIP orders INITIATED on run_date (AutoPay notice sent today -> debit tomorrow).
    Fallback: ACTIVE plans whose schedule says tomorrow (catches plans with no order row yet)."""
    sipo = orders[orders.buy_mode == 'SIP']
    today = sipo[(sipo.created_at.str[:10] == run_date) & (sipo.status == 'INITIATED')]
    from_orders = today.groupby(['user_id', 'sip_plan_id'], as_index=False).agg(
        amount=('amount_inr', lambda s: s.astype(float).sum()))
    from_orders['source'] = 'order_initiated'

    tmr = datetime.strptime(run_date, '%Y-%m-%d') + timedelta(days=1)
    act = plans[(plans.status == 'ACTIVE') & (plans.first_debit_date != '') & (plans.first_debit_date <= tmr.strftime('%Y-%m-%d'))]
    due = act[(act.frequency == 'DAILY')
              | ((act.frequency == 'WEEKLY') & (act.debit_day.str.upper() == tmr.strftime('%A').upper()))
              | ((act.frequency == 'MONTHLY') & (act.debit_day == str(tmr.day)))]
    from_plans = due[['user_id', 'sip_plan_id']].copy()
    from_plans['amount'] = due.amount_inr.astype(float)
    from_plans['source'] = 'plan_schedule'

    both = pd.concat([d for d in (from_orders, from_plans) if not d.empty]).drop_duplicates('sip_plan_id', keep='first')
    return both.merge(plans[['sip_plan_id', 'product', 'basket_id', 'fund_id', 'frequency']], on='sip_plan_id', how='left')


def failure_history(orders, run_date):
    """Per plan: trailing streak of insufficient_funds failures and count in last 14 days (debits up to last night)."""
    sipo = orders[(orders.buy_mode == 'SIP') & (orders.created_at.str[:10] < run_date)].copy()
    sipo['d'] = sipo.created_at.str[:10]
    g = sipo.groupby(['sip_plan_id', 'd']).agg(status=('status', 'first'), reason=('failure_reason', 'first')).reset_index()
    g['ins'] = (g.status == 'FAILED') & (g.reason == 'insufficient_funds')
    last_night = (datetime.strptime(run_date, '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d')
    d14 = (datetime.strptime(run_date, '%Y-%m-%d') - timedelta(days=14)).strftime('%Y-%m-%d')

    out = {}
    for pid, df in g.groupby('sip_plan_id'):
        df = df.sort_values('d', ascending=False)
        streak = 0
        for ins in df.ins:
            if ins: streak += 1
            else: break
        out[pid] = dict(
            streak=streak,
            failed_last_night=bool(((df.d == last_night) & df.ins).any()),
            ins_14d=int(df[(df.d >= d14)].ins.sum()),
            attempts_14d=int((df.d >= d14).sum()),
        )
    return pd.DataFrame.from_dict(out, orient='index').rename_axis('sip_plan_id').reset_index()


def latest_balance(balances, mand_acct, user_id, cutoff):
    """Latest balance for the mandate-linked account as of cutoff; fallback to any account (low confidence)."""
    b = balances[(balances.user_id == user_id) & (balances.ts <= cutoff)].sort_values('ts')
    if b.empty:
        return None
    acct = mand_acct.get(user_id)
    linked = b[b.acct == acct] if acct else b.iloc[0:0]
    if not linked.empty:
        r = linked.iloc[-1]; conf = 'linked_account'
    else:
        r = b.iloc[-1]; conf = 'other_account'
    age_h = (cutoff - r.ts).total_seconds() / 3600
    return dict(balance=r.balance, balance_acct=r.acct, balance_ts=r.ts, balance_age_h=round(age_h, 1),
                balance_conf=conf if age_h <= BALANCE_FRESH_HOURS else conf + '_stale')


# ----------------------------------------------------------------------------- decision
def decide(row):
    """Return (decision, reason). Priority ladder is handled by the voice agent, not here."""
    amt = row.amount + BUFFER_INR
    bal = row.get('balance')
    chronic = row.failed_last_night or row.streak >= 2 or row.ins_14d >= 3
    fresh = isinstance(row.get('balance_conf'), str) and not row.balance_conf.endswith('_stale')

    if bal is not None and fresh:
        if bal >= amt + MIN_BALANCE_FLOOR_INR:
            return 'NO_CALL', f'balance {bal:.0f} covers {row.amount:.0f} with margin'
        if bal >= amt:   # thin: above the debit but inside the bank's minimum-balance floor
            return ('CONVERSATION_CALL', f'thin margin ({bal:.0f} vs {row.amount:.0f}), bounced before (streak={row.streak}, 14d fails={row.ins_14d})') if chronic \
                else ('NO_CALL', f'balance {bal:.0f} covers {row.amount:.0f}, thin but no failure history')
        return ('CONVERSATION_CALL', f'short by {amt-bal:.0f}, chronic (streak={row.streak}, 14d fails={row.ins_14d})') if chronic \
            else ('INFO_CALL', f'short by {amt-bal:.0f}, first-time')
    # balance unknown or stale -> fall back to behaviour
    if chronic:
        return 'CONVERSATION_CALL', f'no fresh balance; chronic (streak={row.streak}, 14d fails={row.ins_14d})'
    if row.streak >= 1:
        return 'INFO_CALL', 'no fresh balance; failed once recently'
    return 'NO_CALL', 'no fresh balance; no failure signal'


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run-date', default='2026-10-14')
    ap.add_argument('--run-time', default='19:00')
    ap.add_argument('--data', default='buildathon-data')
    ap.add_argument('--out', default='pipeline/out')
    a = ap.parse_args()
    cutoff = pd.Timestamp(f'{a.run_date} {a.run_time}')

    print('loading...', file=sys.stderr)
    plans = pd.read_csv(f'{a.data}/investment/sip_plans.csv', dtype=str, keep_default_na=False)
    orders = pd.read_csv(f'{a.data}/investment/orders.csv', dtype=str, keep_default_na=False)
    cust = pd.read_csv(f'{a.data}/loan/customers.csv', dtype=str, keep_default_na=False)[['user_id', 'first_name', 'last_name', 'mobile', 'city']]
    sms = load_sms(f'{a.data}/sms/sms.csv')
    balances = parse_balances(sms)
    mand_acct = mandate_accounts(sms)

    due = upcoming_debits(orders, plans, a.run_date)
    hist = failure_history(orders, a.run_date)
    df = due.merge(hist, on='sip_plan_id', how='left')
    for c, v in (('streak', 0), ('ins_14d', 0), ('attempts_14d', 0)):
        df[c] = df[c].fillna(v).astype(int)
    df['failed_last_night'] = df.failed_last_night.fillna(False).astype(bool)

    bal_rows = [latest_balance(balances, mand_acct, u, cutoff) or {} for u in df.user_id]
    df = pd.concat([df.reset_index(drop=True), pd.DataFrame(bal_rows)], axis=1)
    df['mandate_acct'] = df.user_id.map(mand_acct)
    df[['decision', 'decision_reason']] = df.apply(lambda r: pd.Series(decide(r)), axis=1)
    df = df.merge(cust, on='user_id', how='left')
    df['debit_date'] = (datetime.strptime(a.run_date, '%Y-%m-%d') + timedelta(days=1)).strftime('%Y-%m-%d')

    cols = ['decision', 'decision_reason', 'user_id', 'first_name', 'mobile', 'city', 'sip_plan_id', 'product', 'frequency',
            'amount', 'debit_date', 'source', 'balance', 'balance_acct', 'mandate_acct', 'balance_ts', 'balance_age_h',
            'balance_conf', 'streak', 'failed_last_night', 'ins_14d', 'attempts_14d']
    df = df[cols].sort_values(['decision', 'streak'], ascending=[True, False])

    import os; os.makedirs(a.out, exist_ok=True)
    path = f'{a.out}/call_list_{a.run_date}.csv'
    df.to_csv(path, index=False)

    print(f'\nrun_date={a.run_date} cutoff={cutoff}  -> {path}')
    print('plans due tomorrow:', len(df), ' users:', df.user_id.nunique(), f' amount at risk: ₹{df.amount.sum():,.0f}')
    print('by source:', df.source.value_counts().to_dict())
    print('decisions:', df.decision.value_counts().to_dict())
    print('with balance signal:', df.balance.notna().sum(), ' fresh+linked:', (df.balance_conf == 'linked_account').sum())
    calls = df[df.decision != 'NO_CALL']
    print(f'\n--- call queue ({len(calls)}) with a balance signal or known name:')
    print(calls[calls.balance.notna() | calls.first_name.notna()].head(25)[
        ['decision', 'first_name', 'mobile', 'product', 'amount', 'balance', 'balance_conf', 'streak', 'ins_14d', 'decision_reason']].to_string(index=False))


if __name__ == '__main__':
    main()

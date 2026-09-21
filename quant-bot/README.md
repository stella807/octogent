# quant-bot

A crypto trading bot built to tell you the truth about itself.

It was written as an answer to a specific genre of video — "this AI agent turned
$50 into $5,000" — and to a specific request: *build one with 0% losses.*

## The 0% losses question, answered up front

**You cannot build a trading bot with no losing trades.** Not with better code,
not with a bigger model, not with more indicators. If a system takes market
risk, some of its trades lose. Anything that appears otherwise is one of:

- a backtest that quietly reads future prices,
- a backtest charging no fees or slippage,
- a sample of 8 trades in a bull market,
- a screenshot of a demo account,
- a lie selling a course.

What you *can* engineer is everything around the losses: how big each one is,
how many can happen in a row, and whether the account survives them. That is
what this repo does. Run `montecarlo` on any strategy here and it prints a line
called **P(ending below start)**. On the default strategy over eight years of
real BTC data that number is **1.40%**. It is small. It is not zero, and no
amount of engineering will make it zero.

## "Make it 99% profitable trades"

A 99% win rate is easy. It is a dial, not an achievement, and `take-profit-scalp`
is in this repo so you can turn it yourself: take a tiny profit immediately, put
the stop far away, and the win rate goes wherever you point it.

Same eight years of real BTC/USD, same fees:

| takeProfit | stop | win rate | trades | return | avg win | avg loss |
|---|---|---|---|---|---|---|
| 0.5% | 50% | 96.41% | 223 | +5.3% | $5.82 | $90.67 |
| 0.5% | 75% | 98.46% | 130 | +3.1% | $3.58 | $75.47 |
| 0.25% | 90% | **98.82%** | 85 | **+2.1%** | $2.98 | $40.04 |

98.82% of trades profitable. Over eight years it turned $10,000 into $10,210,
while buy-and-hold made $122,600. Each loss erases thirteen wins.

Now remove the stop entirely — which is what actually produces a *100%* win
rate, because a position you never close is never a loss:

```
node --experimental-strip-types src/cli.ts backtest --exchange coinbase \
  --symbol BTC/USD --bars 3000 --strategy take-profit-scalp \
  --param takeProfitPct=0.5 --param stopPct=0
```

```
Total return      -14.77%
Win rate           80.00%      4 wins of ~$354, then one loss of $2,893
Max drawdown       25.46%
RISK HALT          drawdown 25.34% hit the 25% kill switch  (2018-08-08)
```

Three weeks in, the kill switch shut it down. That is the reel bot, in full:
a near-perfect win rate, a screenshot-ready streak, and one trade that takes
back all of it and more. On synthetic data containing actual bear markets,
`take-profit-scalp` loses money at **every** stop width tested.

The number that matters is not win rate. It is **expectancy**: average win ×
win rate minus average loss × loss rate, after fees. A strategy winning 40% of
the time with a 3:1 payoff beats one winning 99% of the time with a 1:13 payoff,
and the second one is the one that gets sold to you.

## What it actually does on real data

Eight years of BTC/USD daily bars from Coinbase (2018-07 → 2026-09), 0.10% taker
fee and 0.05% slippage per side, 1% of equity risked per trade:

| strategy | return | max drawdown | avg exposure | Calmar | trades | loss rate |
|---|---|---|---|---|---|---|
| buy-and-hold | +1126% | **76.7%** | 100% | 0.47 | 1 | 0% |
| donchian-breakout | +28.1% | **4.2%** | 3.0% | **0.72** | 41 | 56.1% |
| ema-crossover | +27.1% | 4.8% | 4.7% | 0.62 | 65 | 58.5% |
| rsi-mean-reversion | −2.5% | 2.6% | 0.2% | −0.12 | 6 | 66.7% |

Read that honestly:

- **Buy-and-hold made forty times more money.** It also asked you to sit through
  a 76% drawdown without selling. Most people do not.
- The trend strategies beat buy-and-hold **on risk-adjusted terms** (Calmar)
  while holding about 3% average exposure. They are not better at making money;
  they are better at not losing it.
- Every profitable strategy here **loses more often than it wins**. Donchian
  loses 56% of its trades. That is what a working trend system looks like.
- Walk-forward on the same data gives **+2.2% out-of-sample with 18 trades** —
  and the report says, in those words, that 18 trades proves nothing.

No strategy in this repo will turn $50 into $5,000. That is the honest result,
and a tool that reports it is worth more than one that doesn't.

## The bear market, which is where strategies actually get judged

Every backtest that ends today ends near an all-time high, and that flatters
everything in it. `--since` / `--until` exist so you can point the tool at the
window that matters. Nov 2021 - Dec 2022, same fees:

| strategy | return | max drawdown | avg exposure |
|---|---|---|---|
| buy-and-hold | **−72.96%** | 76.67% | 99.8% |
| vol-target | −9.10% | 11.69% | 2.1% |
| ema-crossover | −2.34% | 2.43% | 0.4% |
| donchian-breakout | **−1.66%** | 1.77% | 0.4% |

```bash
node --experimental-strip-types src/cli.ts compare \
  --exchange coinbase --symbol BTC/USD --since 2021-11-01 --until 2022-12-31
```

This is the entire case for trend following. It does not beat buy-and-hold in a
bull market and it is not supposed to. It loses 1.7% in the year buy-and-hold
loses 73%, and that is what lets you still be trading afterwards.

## Volatility targeting, and why the win rate is 25%

`vol-target` sizes inversely to realised volatility: hold less when the market
is wild, more when it is calm, so risk stays roughly constant instead of
tracking whatever the asset is doing. It is the one idea here that institutions
actually run. Eight years of BTC/USD:

```
Total return       398.38%        Win rate          25.49%
CAGR                21.59%        LOSS RATE         74.51%
Max drawdown        20.19%        Worst streak      8 losses
Calmar                1.07        Payoff ratio      8.23
```

Compare that to the 98.82% bot above. This one **loses three trades out of
four**, and it is the one that makes money, because its wins are eight times
the size of its losses. Win rate and profitability are close to unrelated.

One honest caveat, and it is a big one: walk-forward on the same data returns
only **+4.73% out-of-sample** with an efficiency of 0.67. The 398% comes from
parameters that happen to suit the whole sample. The out-of-sample number is
the one to believe, and the gap between them is exactly what walk-forward
exists to expose.

## Portfolio mode

The single biggest real improvement available, because it diversifies the
drawdowns rather than trying to predict better. `cross-sectional-momentum`
ranks a universe by trailing return, holds the strongest few, and requires
positive absolute momentum so it sits in cash when everything is falling.

Six Coinbase pairs (BTC, ETH, SOL, LTC, LINK, AVAX), weekly rebalance:

| | return | max drawdown | **Calmar** |
|---|---|---|---|
| cross-sectional-momentum | +213.8% | 40.5% | **1.03** |
| equal-weight benchmark | +164.6% | 66.3% | 0.52 |

Twice the risk-adjusted return of simply holding the basket.

```bash
node --experimental-strip-types src/cli.ts portfolio \
  --exchange coinbase --strategy cross-sectional-momentum \
  --symbols BTC/USD,ETH/USD,SOL/USD,LTC/USD,LINK/USD,AVAX/USD --max-drawdown 40
```

Two things the report tells you that the headline number does not. **Per-symbol
contribution**: SOL and AVAX produced most of the gain, so the diversification
was partly nominal. And at the default 25% drawdown limit the kill switch fires
in Jan 2024 and the strategy never trades again — +171% instead of +214%, with
10% time in market. A concentrated crypto portfolio needs a wider limit than a
single-asset trend system, and the tool makes you confront that rather than
discovering it live.

## Quick start

```bash
pnpm install
pnpm test                 # 208 tests, no network needed
pnpm build

# Runs offline against seeded synthetic data
node --experimental-strip-types src/cli.ts backtest --synthetic

# Real data. Binance returns HTTP 451 in some regions; coinbase and kraken work.
node --experimental-strip-types src/cli.ts compare \
  --exchange coinbase --symbol BTC/USD --timeframe 1d --bars 3000
```

## Commands

| command | what it tells you |
|---|---|
| `backtest` | Full risk report for one strategy, benchmarked against buy-and-hold |
| `compare` | Every strategy over the same history and the same costs |
| `walkforward` | What survives when parameters are chosen without seeing the test data |
| `montecarlo` | How much of the result was the order the trades happened to arrive in |
| `portfolio` | A multi-asset strategy against an equal-weight benchmark |
| `paper` | Live market data, simulated fills, no real money |
| `live` | Real orders. Two independent gates stand in front of it. |

`--help` lists every flag.

## How it avoids the five ways backtests lie

**1. Lookahead.** A signal computed from the close of bar *i* is filled at the
**open of bar *i+1***. Never the close of the bar that produced it. This single
rule is worth most of the apparent edge in published strategies, and
`test/no-lookahead.test.ts` enforces it as a property: every strategy must
return the identical signal for bar *i* whether or not bars after *i* exist, and
a backtest on truncated data must produce a trade history that is a prefix of
the longer run's.

Protective stops are the one exception — they are resting orders, so they fill
intrabar. When a bar gaps straight through the stop, the fill is **the gapped
open, not the stop price**, because that is what actually happens to you.

**2. Free trading.** Fees and slippage are charged on both sides of every round
trip, defaulting to 0.10% + 0.05% per side. The report prints the round-trip
cost next to the average win so you can see when a strategy is just a fee pump.

**3. Curve fitting.** `walkforward` picks parameters on bars that came *before*
each scored segment, tiles the out-of-sample windows contiguously so no history
goes untested, and reports **walk-forward efficiency** — out-of-sample
performance over in-sample. Below 0.5 means the edge was fitted, and the report
says so in plain words.

**4. One lucky sequence.** `montecarlo` resamples the realised trades to show the
distribution the single backtest drew from. It compounds each trade's return on
*total equity*, not on the capital committed to it — conflating those overstates
both returns and drawdowns by roughly the inverse of the position size.

**5. No benchmark.** Every backtest prints buy-and-hold over the same bars, with
risk halts disabled so it measures the asset rather than the risk manager. If
buy-and-hold wins on Calmar, the report says the strategy is not earning its
complexity.

Small samples are called out automatically. Under 30 trades, the report tells
you to disregard the ratios. An infinite profit factor is labelled as a
sample-size artefact, not a perfect strategy.

## Risk limits

`src/risk/risk-manager.ts` is the part that actually matters, and the same
object runs in backtests and live trading so the two cannot drift apart.

| limit | default | what it does |
|---|---|---|
| `riskPerTradePct` | 1% | Position sized so the stop costs exactly this much |
| `maxPositionPct` | 100% | Spot only — values above 100 are rejected outright |
| `maxDailyLossPct` | 5% | Flattens and pauses trading until the next UTC day |
| `maxDrawdownPct` | 25% | Kill switch. Fires once and never un-fires. |
| `minEquity` | 0 | Stops trading rather than grinding the account to dust |

Four properties worth knowing:

- Drawdown is measured **from the peak**, not from the starting balance. Up 400%
  then down 60% trips the switch, because that is when a strategy has stopped
  working.
- The kill switch marks on **unrealised** equity. One that only counted closed
  trades would not fire during the open position destroying the account.
- It **survives restarts**, persisted in the runner state file. A halt that
  clears on restart is not a halt, it is a pause between attempts at the same
  loss. Clearing it is a deliberate human act: delete the state file.
- It **never un-fires**, even if equity recovers to a new high.

The sizing arithmetic is the honest answer to "how do I get big returns without
big risk". At 1% risk with a 2.5×ATR stop on an asset at 80% annualised
volatility, the position is about 10% of equity. That is why the table above
shows 3% average exposure and 28% returns instead of 1126%. You can raise
`--risk`, and the drawdown rises with it, linearly. There is no setting that
gives you the return without the drawdown.

## Running it continuously

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f paper
```

Paper mode by default: no credentials, no real money. State lives in a named
volume, which is the point — `restart: unless-stopped` means a crashing
container comes straight back, and a kill switch that reset on restart would be
no kill switch at all. A tripped halt stays tripped until a human deletes the
state file.

The image runs as an unprivileged user and contains no credentials. Live
trading still requires `--live` and `QUANT_BOT_LIVE_CONFIRM`, neither of which
is baked in.

## Going live

Paper trading is the default and needs no credentials. Live trading requires
**both** of:

```bash
export QUANT_BOT_LIVE_CONFIRM=yes-i-accept-the-risk
export QUANT_BOT_API_KEY=...      # trade permission only; never withdrawal
export QUANT_BOT_API_SECRET=...

node dist/cli.js live --live --exchange kraken --symbol BTC/USD --strategy donchian-breakout
```

Two gates, on purpose: the most common way an automated system loses money is a
test run pointed at the wrong endpoint, and a single flag is one typo away from
that. Credentials are read from the environment, never from argv, where they
would land in shell history and `ps` output.

The runner only ever acts on **closed** bars, and records the last bar it acted
on so a crash-restart loop cannot re-place the same order.

One real limitation, stated plainly: the live stop is **poll-based**. Between
polls the position is unprotected. For any timeframe above a few minutes, also
leave a resting stop order on the exchange — the runner's check is a backstop,
not the primary protection.

## Strategies

| strategy | shape | why it is here |
|---|---|---|
| `buy-and-hold` | always long | The benchmark. Beating it is the bar. |
| `donchian-breakout` | trend, N-bar channel + ATR stop | Low win rate, high payoff — survives regime change |
| `ema-crossover` | trend, fast/slow EMA + ATR stop | The simplest trend filter that works |
| `rsi-mean-reversion` | oversold dips above a trend filter | High win rate; included to show that shape's risk |
| `vol-target` | exposure inverse to realised volatility | 25% win rate, 8:1 payoff. What actually works. |
| `take-profit-scalp` | tiny target, distant or absent stop | **Not for trading.** The 99%-win-rate demo above. |

Multi-asset strategies, for the `portfolio` command:

| strategy | shape |
|---|---|
| `equal-weight` | Hold the whole universe evenly. The portfolio benchmark. |
| `cross-sectional-momentum` | Hold the strongest few, in cash when all are falling. |

Adding one means implementing `Strategy` in `src/strategy/` and registering it.
The contract is a single rule: `signalAt(i)` may read `candles[0..i]` and nothing
past it. The property test will catch you if you break it.

Note that mean reversion barely trades on the synthetic data, by construction —
synthetic bars are geometric Brownian motion, which has no mean reversion to
find. That is the generator being honest, not a bug.

## Layout

```
src/
  domain/      Value types shared by backtest and live
  indicators/  Causal indicators: slot i uses inputs 0..i only
  strategy/    Strategies + the registry
  risk/        Position sizing, daily loss limit, drawdown kill switch
  backtest/    Engine, cost model, metrics, walk-forward, Monte Carlo
  data/        Exchange fetch with disk cache, CSV loader, synthetic generator
  live/        Broker interface, paper broker, gated exchange broker, runner
  report.ts    Text reports, including the automatic reality checks
test/          208 tests
```

## What this is not

It is not financial advice, and it is not a money printer. It is a research
harness that makes it hard to fool yourself, with an execution path attached.

The honest use of it: run `walkforward`, look at the efficiency number, run
`montecarlo`, look at **P(ending below start)**, and only then decide whether
anything here deserves your money. Quite often the answer the tool gives is
"buy-and-hold beats this" — and printing that clearly is the whole point.

Trade with money you can afford to lose entirely.

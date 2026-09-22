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
pnpm test                 # 272 tests, no network needed
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
| `blend` | Several strategies at once, each on its own slice of capital |
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

## How small an account can be

Risk-based sizing makes the position a fraction of equity, so below some
balance that fraction falls under the exchange minimum and every order is
rejected. `--min-order` models that (Coinbase Advanced is around $1, Binance
$5-10), and the report warns when the account cannot clear it.

At 1% risk with a 2.5x ATR stop about 10% below entry, the position is roughly
a tenth of the account, so a $1 minimum needs about **$10** to place one legal
order. Run a backtest at `--equity 5` and it says so: **259 orders below the
minimum, never placed**, and one trade in eight years.

The dollar figures in every table above are percentages of the account, not
fixed amounts. The same strategy that wins $2.98 and loses $40.04 on $10,000
wins $0.0015 and loses $0.02 on $5, for the identical 2.10% return. Shrinking
the account shrinks both sides equally — it caps what you can lose, which is
real, and it does not improve anything.

For learning, paper trading beats a small live account outright: no minimum
order size, no dust, and the full strategy actually runs.

## Risk limits

`src/risk/risk-manager.ts` is the part that actually matters, and the same
object runs in backtests and live trading so the two cannot drift apart.

| limit | default | what it does |
|---|---|---|
| `riskPerTradePct` | 1% | Position sized so the stop costs exactly this much |
| `maxPositionPct` | 100% | Spot only — values above 100 are rejected outright |
| `maxDailyLossPct` | 5% | Flattens and pauses trading until the next UTC day |
| `maxDrawdownPct` | **15%** (default when running the CLI) | Kill switch. Fires once and never un-fires. |
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

**Why 15%, not 25%.** `RiskLimits.DEFAULT_LIMITS` in the code is 25%, which is
the research setting — loose on purpose, so a backtest shows a strategy's full
behavior. The CLI's actual default is `CONSERVATIVE_LIMITS` at 15%, chosen from
evidence rather than a round number: `donchian-breakout` over 8 years of real
BTC data realised a 4.24% drawdown, and reshuffling the same trades 5,000 times
(`montecarlo`) put the 95th-percentile outcome at 8.51% and the worst resampled
path at 16.43%. A cap set at the historical minimum (e.g. 5%) is not a safety
margin — it is a bet that the next stretch of ordinary bad luck is no worse
than the luckiest path already observed, and testing it live halts the bot
within the first year. 15% sits above that range, so the switch fires on an
actual regime change, not on noise. Override with `--max-drawdown` if you want
the research default back, or tighter — but test the number against
`montecarlo` first, the way this one was chosen.

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

## Overnight research pass (2026-09-22)

Searched for documented crypto strategies rather than inventing new ones, and
tested whatever looked credible through the same walk-forward and bear-market
checks as everything else here. Three findings, sources below.

**1. Time-series momentum has real academic support — until costs are applied.**
Evidence for the effect is strong at daily/weekly frequency, but "when
appropriately assessed, accounting for transaction costs... many momentum
portfolios are liquidated." Built `tsmom`: the textbook version (long when the
trailing N-bar return is positive, nothing more elaborate). On real BTC data it
walk-forwards to **-0.26% out-of-sample, efficiency 0.29** — most of its
in-sample edge is curve fitting, and the report says so automatically. In the
2021-2022 bear market, the specific regime the research says momentum should
help most, it still loses more than the existing `donchian-breakout` and
`ema-crossover` already in this repo (-3.07% vs -1.66% / -2.34%). The simpler
the momentum rule, the more of it is fees. [Han, Kang & Ryu, SSRN](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4675565)

**2. Z-score mean reversion has a vendor claim behind it, not a peer-reviewed one.**
An industry backtest reported Z-scores beyond +/-2.5 reverting 81% of the time
within 5 days. Built `bollinger-reversion` to test that threshold directly,
with the same trend filter as the existing RSI strategy. It barely trades
(10 trades in 8 years) and walk-forwards to **-1.60%, efficiency -0.16** —
negative, meaning the out-of-sample result is worse than doing nothing. The
claim did not survive contact with this repo's validation. [Coinquant, "Building a Mean-Reversion Strategy... Evidence from 78 Backtests"](https://www.coinquant.ai/blog/building-a-mean-reversion-strategy-in-cryptocurrency-markets-evidence-from-78-backtests)

**3. Funding-rate arbitrage is the one strategy institutions actually call
reliable — and it is deliberately out of scope.** It profits from the spread
between a perpetual future's funding rate and spot, market-neutral because it
holds spot long against a perpetual short. That requires leverage and a short
position, both of which this project excludes on purpose: spot-only with no
leverage bounds the worst case on any single position to the position itself.
Implementing it responsibly would mean building liquidation handling and
cross-market margin risk from scratch, not bolting a new strategy onto the
existing spot engine. Real, but a different project. [Kraken, "Funding rate arbitrage in crypto"](https://www.kraken.com/learn/futures-trading-funding-rate-arbitrage)

Net effect on what to trade: **nothing changes.** `donchian-breakout`,
`ema-crossover`, and `vol-target` (with its walk-forward caveat already
documented above) remain the only strategies in this repo whose out-of-sample
numbers are worth anything. Two more ideas were tested and rejected by the same
bar everything else here is held to, which is the point of building the bar
first.

## Sentiment tracking — built, tested, and it made things worse

Real request: track sentiment and use it. Built it properly rather than
arguing about it — `donchian-sentiment` reads the public crypto Fear & Greed
Index (alternative.me, daily since 2018) and refuses a new breakout entry
when yesterday's reading was in "extreme greed" territory, on the theory that
a breakout during broad euphoria is more likely a blow-off top than a real
trend start. The reading is lagged a full day specifically so the strategy
can never act on a sentiment value published after the bar it's trading on —
the same causality rule as every price-based indicator here, extended to a
new kind of input.

Tested it exactly like everything else, full sample and walk-forward, against
the `donchian-breakout` it's built on top of:

| | full-sample return | Calmar | walk-forward OOS |
|---|---|---|---|
| donchian-breakout (no filter) | +28.12% | 0.72 | +2.20% |
| donchian-sentiment (greed-gated) | **+22.91%** | **0.50** | **-0.81%** |

The filter didn't help. It hurt, on both counts — worse full-sample return,
worse risk-adjusted return, and out-of-sample it loses money where the
ungated version made a small amount. Skipping "greedy" breakouts filtered out
profitable trades along with whatever it was supposed to avoid; the intuition
that euphoria precedes tops didn't survive contact with the data at this
threshold and lag. This is one specific, honest implementation of the idea —
a different threshold or a shorter lag might do better — but it is not
currently something this repo recommends trading, and the code and the
negative result are both in the tree rather than only the code.

The other half of "sub-agents that research" — the automated literature scan
for new strategies — is the section above and the walk-forward tooling
underneath it. It is not a separate system; it is this same process, run
again.

## Running strategies in parallel — tested, doesn't beat the best one alone

`blend` runs several strategies at once, each managing its own fixed slice of
starting capital, then combines them into one account -- the strategy-level
version of portfolio mode's asset diversification. Tested two pairings on
real BTC data:

| blend | return | max drawdown | Calmar |
|---|---|---|---|
| vol-target alone | +175.54% | 15.45% | **0.85** |
| donchian-breakout + vol-target (50/50) | +101.83% | 12.14% | 0.74 |
| donchian-breakout + rsi-mean-reversion (50/50) | +12.80% | 3.21% | 0.46 |

Neither blend beats running the single best strategy alone with full capital.
Both are long-only trend systems on the same asset, so they tend to draw down
together -- there isn't enough independence between the decision rules for
diversification to pay off, the same way asset diversification only helps to
the extent the assets are not just leveraged copies of the same bet.

```bash
node --experimental-strip-types src/cli.ts blend --exchange coinbase \
  --symbol BTC/USD --strategies donchian-breakout,vol-target
```

## Social sentiment (Twitter/X, Truth Social): researched, not built

Truth Social has no public developer API. The only official access, "Truth
API," launched in 2026 at $60,000-$100,000/month, sold to financial firms
specifically because Trump's posts move markets fast enough that speed of
access is worth that price -- which confirms the underlying idea is real,
and confirms it is priced entirely out of reach here. [Euronews, "What is Truth API?"](https://www.euronews.com/business/2026/08/13/what-is-truth-api-the-100000-feed-that-has-landed-trump-a-lawsuit)

Twitter/X's API has been paid and expensive since 2023. Free social-sentiment
aggregators (LunarCrush, Santiment) exist, but their free tiers are either
narrow or run a 30-day lag -- a month-old sentiment reading is not usable for
trading a bar that closed today.

Unofficial scrapers exist for both platforms. Not used here, for the same
reason the invite-only TradingView script wasn't trusted earlier: this repo
only integrates sources it can vouch for. `donchian-sentiment`'s Fear & Greed
Index already incorporates social media volume as one of its several inputs,
aggregated and lagged properly -- that is the legitimate version of this idea
already in the tree, and it is documented above as a negative result.

## The indicator checklist from the reel — built for real, and it fails too

A screenshot made the rounds of TradingView's "DIY Custom Strategy Builder,"
a checkbox panel with 30+ indicators (TSI, TDFI, McGinley Dynamic, Ichimoku,
B-Xtrender, VWAP, Chandelier Exit, Vortex, and more) and no disclosed rule for
combining any of them. Two were specifically called out: B-Xtrender and
"Range Detector."

Built both to their real specs rather than guessing. B-Xtrender is a
published, well-documented indicator (RSI applied to EMA spreads, on two
timeframes) -- implemented faithfully. "Range Detector" is a generic name
several unrelated TradingView scripts use with different formulas, and the
specific one in the screenshot isn't published anywhere accessible, so
`bxtrender-adx` substitutes Wilder's ADX -- the textbook method for the same
question ("is this market trending or ranging") that predates every
community variant. That substitution is stated here, not left implicit.

Combined the way they're meant to be used: B-Xtrender reads trend direction,
ADX gates whether the market is trending strongly enough to act on it.

Full-sample, this one actually looked good -- **the lowest max drawdown of
any trend strategy tested** (4.01%, versus 4.24% for donchian-breakout):

| | full-sample return | max drawdown | Calmar | walk-forward OOS |
|---|---|---|---|---|
| bxtrender-adx | +24.55% | **4.01%** | 0.67 | **-0.41%** |

Then walk-forward: **-0.41% out-of-sample, efficiency 0.12.** Same failure as
every other strategy stacked from indicator checklists tonight (tsmom,
bollinger-reversion, donchian-sentiment). More indicators combined into a
plausible-sounding rule is not more edge -- it's more knobs to accidentally
tune to the specific history being stared at, which is exactly what
walk-forward exists to catch. A bug was also caught building this: the ADX
implementation's seeding step summed one extra DX value before averaging,
inflating early readings above the mathematically-guaranteed 0-100 bound --
caught by a test asserting that exact bound, not by eyeballing the numbers.

## Strategies

| strategy | shape | why it is here |
|---|---|---|
| `buy-and-hold` | always long | The benchmark. Beating it is the bar. |
| `donchian-breakout` | trend, N-bar channel + ATR stop | Low win rate, high payoff — survives regime change |
| `ema-crossover` | trend, fast/slow EMA + ATR stop | The simplest trend filter that works |
| `rsi-mean-reversion` | oversold dips above a trend filter | High win rate; included to show that shape's risk |
| `vol-target` | exposure inverse to realised volatility | 25% win rate, 8:1 payoff. What actually works. |
| `tsmom` | textbook time-series momentum | Tested from literature; fails walk-forward (efficiency 0.29). |
| `bollinger-reversion` | Z-score mean reversion vs. rolling mean | Tested from a vendor claim; fails walk-forward (efficiency -0.16). |
| `donchian-sentiment` | donchian-breakout, gated by Fear & Greed Index | Tested the sentiment hypothesis directly; it made returns worse, not better. |
| `bxtrender-adx` | B-Xtrender direction, gated by ADX trend strength | From the viral indicator-checklist screenshot; fails walk-forward (efficiency 0.12). |
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
docs/architecture.md   Diagrams of the pipeline, fill timing and kill switch
test/          272 tests
```

## What this is not

It is not financial advice, and it is not a money printer. It is a research
harness that makes it hard to fool yourself, with an execution path attached.

The honest use of it: run `walkforward`, look at the efficiency number, run
`montecarlo`, look at **P(ending below start)**, and only then decide whether
anything here deserves your money. Quite often the answer the tool gives is
"buy-and-hold beats this" — and printing that clearly is the whole point.

Trade with money you can afford to lose entirely.

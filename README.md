# Polymarket Copy Trading Bot

Automatically mirror trades from profitable Polymarket wallets in real time. Pick a winning trader, point the bot at their wallet, and let it replicate every move — buys, sells, and automatic profit redemption.

## Why Copy Trading Works on Polymarket

Polymarket is a prediction market. The best traders consistently identify mispriced outcomes before the crowd catches on. Their edge comes from research, modeling, and speed — things you can borrow simply by copying their on-chain activity the moment it happens.

**With the right target wallet, this bot turns someone else's alpha into your profit.**

- A trader who is 60%+ accurate on binary markets generates compounding returns over time.
- You ride the same positions with zero research overhead.
- The bot handles everything: detection, execution, position tracking, and cashing out.

The only decision you need to make is **who to follow**.

## How It Works

1. The bot opens a real-time WebSocket connection to Polymarket's trade feed.
2. When the target wallet places a trade, the bot detects it within milliseconds.
3. It mirrors the trade on your account — same market, same direction, scaled to your configured size.
4. When markets resolve, the bot automatically redeems your winning positions for USDC.

That's it. Set it up once, fund your wallet, and let it run.

## Getting Started

### Prerequisites

- **Bun** runtime (v1.0+) — [Install Bun](https://bun.sh)
- A **Polygon wallet** funded with USDC
- A **target wallet address** — the trader you want to copy

### Installation

```bash
git clone <repository-url>
cd polymarket-copytrading
bun install
```

### Configuration

Create a `.env` file in the project root:

```env
# Your wallet
PRIVATE_KEY=your_private_key_here

# The trader you want to copy
TARGET_WALLET=0x...

# How much to copy (relative to the target's trade size)
SIZE_MULTIPLIER=0.3

# Safety cap per order (in USDC)
MAX_ORDER_AMOUNT=5

# Auto-redeem winnings every N minutes
REDEEM_DURATION=15

# Enable/disable the bot
ENABLE_COPY_TRADING=true

# Optional — leave blank for sensible defaults
ORDER_TYPE=
TICK_SIZE=
NEG_RISK=

# Network
CHAIN_ID=137
CLOB_API_URL=https://clob.polymarket.com
```

### First Run

```bash
bun src/index.ts
```

On the first launch, the bot will automatically generate your Polymarket API credentials and store them locally. After that, it connects to the trade feed and starts monitoring.

## Configuration Guide

### Choosing a Target Wallet

This is the most important decision. A few tips:

- Look for wallets with a **consistent win rate** across multiple markets, not one lucky bet.
- Check their **trade frequency** — active traders give the bot more opportunities.
- Review their **position sizes** — whales moving large amounts can signal high-conviction plays.
- Avoid wallets that only trade illiquid or niche markets where your order might not fill.

You can find wallet activity on Polymarket's leaderboard or by browsing on-chain data on Polygonscan.

### Sizing Your Trades

| Variable | What It Does | Example |
|----------|-------------|---------|
| `SIZE_MULTIPLIER` | Scales each copied trade relative to the target | `0.3` = 30% of their size |
| `MAX_ORDER_AMOUNT` | Hard cap per order in USDC | `5` = never spend more than $5 per trade |

**Recommended approach**: Start small. Use a low multiplier and a tight max amount while you validate that the target wallet is actually profitable. Scale up once you have confidence.

### Order Types

| Type | Behavior |
|------|----------|
| `FAK` (Fill-and-Kill) | Fills as much as possible immediately, cancels the rest. **Default and recommended.** |
| `FOK` (Fill-or-Kill) | Must fill the entire order or nothing. Use for smaller, liquid markets. |

Leave `ORDER_TYPE` blank to use FAK, which works best for copy trading since partial fills are better than missed trades.

### Auto-Redemption

When a market resolves and you hold the winning outcome, the bot automatically redeems your tokens for USDC.

- `REDEEM_DURATION=15` — checks for resolved markets every 15 minutes
- Set to blank or remove the line to disable auto-redemption
- During redemption, copy trading briefly pauses to avoid conflicts, then resumes

## Usage

### Running the Bot

```bash
# Start the bot
bun src/index.ts

# Or via npm
npm start
```

Once running, the bot will log every detected trade and every copied order:

```
[INFO]  Configuration:
[INFO]    Target Wallet: 0x785E...0EbD
[INFO]    Size Multiplier: 0.3x
[INFO]    Max Order Amount: 5
[SUCCESS] Connected to the server
[SUCCESS] Bot started successfully
[WARNING] Trade detected! Side: BUY, Price: 0.62, Size: 50, Market: Will X happen?
[INFO]  Copying trade with 0.3x multiplier...
[SUCCESS] Trade copied successfully! OrderID: abc123
```

### Manual Redemption

If you don't want to wait for the auto-redemption timer:

```bash
# Redeem all resolved positions
bun src/auto-redeem.ts

# Preview what would be redeemed (dry run)
bun src/auto-redeem.ts --dry-run

# Clear holdings file after redeeming
bun src/auto-redeem.ts --clear-holdings

# Fetch and redeem from API instead of local holdings
bun src/auto-redeem.ts --api
bun src/auto-redeem.ts --api --max 500
```

## How the Bot Manages Your Positions

### Buying

When the target wallet buys into a market:
1. The bot calculates your order size based on `SIZE_MULTIPLIER` and `MAX_ORDER_AMOUNT`.
2. It checks your available USDC balance. If you don't have enough, it adjusts the order down.
3. It handles all token approvals automatically.
4. After a successful fill, it records the position locally for future sell/redemption tracking.

### Selling

When the target wallet sells:
1. The bot checks your local holdings for that token.
2. If you hold tokens, it sells your entire position in that outcome.
3. If you don't hold any, it skips the trade — no short selling.

### Redeeming

When a prediction market resolves:
1. The bot checks which of your held tokens are winners.
2. It calls the Polymarket redemption contract to convert winning tokens back to USDC.
3. It cleans up the local holdings file.

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIVATE_KEY` | Yes | — | Private key of your trading wallet |
| `TARGET_WALLET` | Yes | — | Wallet address to copy |
| `SIZE_MULTIPLIER` | No | `1.0` | Trade size relative to target |
| `MAX_ORDER_AMOUNT` | No | unlimited | Max USDC per order |
| `ORDER_TYPE` | No | `FAK` | `FAK` or `FOK` |
| `TICK_SIZE` | No | `0.01` | Price precision |
| `NEG_RISK` | No | `false` | Allow negative risk orders |
| `ENABLE_COPY_TRADING` | No | `true` | Toggle copy trading on/off |
| `REDEEM_DURATION` | No | disabled | Minutes between auto-redemptions |
| `CHAIN_ID` | No | `137` | Polygon mainnet |
| `CLOB_API_URL` | No | `https://clob.polymarket.com` | API endpoint |

## Risk Management

Copy trading is not risk-free. Manage your exposure:

- **Start small.** Use `SIZE_MULTIPLIER=0.1` and `MAX_ORDER_AMOUNT=2` while testing.
- **Diversify targets.** Run multiple bot instances copying different profitable wallets.
- **Monitor regularly.** Check that your target is still performing. Past performance doesn't guarantee future results.
- **Keep reserves.** Don't allocate 100% of your USDC — leave a buffer for gas and unexpected losses.
- **Use FAK orders.** Partial fills are better than no fills when copying time-sensitive trades.

## Picking Profitable Wallets

The bot is only as good as the wallet you follow. Evaluate candidates by:

1. **Win rate over volume.** 65% accuracy across 100 trades beats 90% across 5.
2. **Market diversity.** Profitable across politics, sports, and crypto — not just one topic.
3. **Consistent sizing.** Disciplined bets, not erratic gambling behavior.
4. **Recent activity.** An inactive wallet means no trades to copy.
5. **Real edge.** Consistently buying outcomes at prices well below final resolution is real alpha.

## License

ISC

---

**Disclaimer**: This software is provided as-is. Prediction market trading carries risk. Never trade more than you can afford to lose. The profitability of this bot depends entirely on the quality of the target wallet you choose to follow.

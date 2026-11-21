<div align="center">

# Slab Arbitrage

**A bot that watches eBay for underpriced graded Pokémon cards and pings you on Discord when one is worth buying.**

<img alt="Alerts on Discord" src="https://img.shields.io/badge/Alerts_on-Discord-24292f?style=for-the-badge"> <img alt="Prices after fees" src="https://img.shields.io/badge/Prices-after_fees-24292f?style=for-the-badge"> <img alt="Learns from every alert" src="https://img.shields.io/badge/Learns_from-every_alert-24292f?style=for-the-badge">

</div>

<br>

Graded cards ("slabs") are easy to compare: the same card, grader and grade should sell for about the same price. Listings still get mispriced, through bad titles, typos or sellers in a hurry, and the good ones sell within minutes. This bot scans new eBay listings around the clock, works out exactly which card and grade each one is, values it from real sold prices, and subtracts fees and shipping. When the profit is real, it sends a Discord alert with a one-tap way to act on it. Every alert is graded afterwards, so its pricing gets sharper over time.

## What you can do with it

- Get a Discord alert for each listing that clears your minimum profit and return, ranked by expected profit times confidence.
- Buy, pass (with a reason) or watch a listing straight from the alert, with links to eBay sold listings, PriceCharting and PSA prices for a quick double-check.
- Match messy listing titles to the exact card, set, grader and grade, and skip anything the matcher isn't sure about.
- Value cards from several price sources, and see an extra eBay sold-listings check that can only downgrade an alert, never upgrade it.
- Track live auctions on a watchlist and get told when one is still a steal near the end.
- Keep a bankroll: deposit cash, and alerts never suggest more than you have.
- Pause or resume everything with `/pause` and `/resume`, check `/status`, and get a weekly report on how past alerts actually turned out.

## How it's built

TypeScript on Node, Postgres in plain SQL with numbered migrations, and discord.js for alerts and commands. Listings come from the eBay Browse API, card data from TCGdex, prices from PokeTrace and PokemonPriceTracker, and USD to CAD rates from Frankfurter. Each step (match, value, score, alert, follow-up) is its own module with pure logic that's tested on its own. It runs as a single always-on service on Railway, and it stores no eBay user data.

## Run it locally

You need Node 20+, Postgres, an eBay developer keyset and a Discord bot.

```bash
git clone https://github.com/james-helou/pokemon-slab-arbitrage.git
cd pokemon-slab-arbitrage
npm install
cp .env.example .env      # fill in the database, eBay and Discord values
npm run migrate
npm run catalog:sync      # load the card catalogue
npm run dev
```

By default prices come from a small sample file (`COMPS_SOURCE=fixture`), so you can try the whole flow without a paid price source.

| Command | What it does |
|---|---|
| `npm run check` | Typecheck, lint, build and tests |
| `npm run report:weekly` | Write last week's report to a markdown file |
| `npm run ebay:probe` | Test your eBay keys with one search |

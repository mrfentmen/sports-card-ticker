# SportsTicker: Card Prices

Search sports cards — baseball, football, basketball, hockey — and watch their market prices like a stock ticker. Track "michael jordan rookie card", "lebron james prizm", "tom brady rookie", or any search you care about and see the median listing price across eBay, a price-history sparkline with trend arrows, and a scrolling ticker tape right from your toolbar.

## Getting started (2 minutes)

Sports prices come from eBay's free Browse API, which needs a developer access token:

1. Create a free app at [developer.ebay.com](https://developer.ebay.com/) (no payment details).
2. Open the [OAuth token generator](https://developer.ebay.com/api-docs/static/oauth-token-generator.html), pick your app, and copy the **access token**.
3. Open the extension, paste the token in the ⚙ settings, hit **Test token**, then **Save & open ticker**.

Tokens expire after about 2 hours — if you see "eBay rejected your token", re-paste a fresh one in ⚙ settings. Your token is stored only in your browser and is sent only to api.ebay.com.

## Features

- Search any sports card against eBay's live listings
- A **median market price** per tracked search (median of active fixed-price listings, so outliers don't distort the number), with the listing count
- Client-side price history: each tracked search keeps its last 40 medians, so you get real trend arrows (▲/▼ vs the previous check) and a mini sparkline — no server-side history needed
- Scrolling ticker tape across the top of the popup
- One click to open the live eBay search for any tracked card
- Auto-refresh while the popup is open
- 12s fetch timeout, 3-try growing-backoff retries, honest "eBay is hiccuping" messages, and token errors pointed straight at the ⚙ settings
- Offline fallback: last good medians stay on screen with their age ("Offline — prices from 3h ago"), color-coded green/amber/red by how stale
- Watchlist persists locally; Ctrl/Cmd +/−/0 zooms the popup if it feels small

## Permissions (least privilege)

- `storage` only, to persist your watchlist and your eBay token locally.
- Host access is limited to `https://api.ebay.com/*` for price data.
- No page access, no content scripts, no tracking.

## Privacy

Your watchlist and token never leave your browser except for the requests the ticker makes to api.ebay.com with your token to fetch prices. The extension sends no personal data and keeps no analytics. See PRIVACY.md.

## Support

Free forever. If the ticker pays for itself, a coffee is appreciated: https://www.buymeacoffee.com/contactae2b. Found a bug? Email contactae2000@gmail.com.

## Development

```bash
npm run syntax   # syntax check the modules
npm test         # unit tests (pure helpers, no network)
```

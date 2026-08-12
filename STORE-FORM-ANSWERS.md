# Chrome Web Store Form Answers

## SportsTicker: Card Prices

**Single purpose description**
Search any sports card (baseball, football, basketball, hockey) and watch its
median eBay market price like a stock ticker. Track card searches, see the
median of active fixed-price listings, price-history sparklines with trend
arrows, and a scrolling price tape — all in a small toolbar popup.

**Permission justification**

`storage`: Saves your watchlist (which card searches you track and their last
seen prices) and your eBay access token locally in your browser so they are
still there the next time you open the popup. The token is stored only on
your device and sent only to eBay's API when the extension fetches prices.

`host_permissions: https://api.ebay.com/*`: Required so the popup can fetch
card search results and current prices from eBay's public Browse API using
your token. No other site is accessed.

**Are you using remote code?**
No, I am not using Remote code.

Justification: All JavaScript is bundled inside the extension package. The
extension fetches listing and price data from eBay's API, but every script
file it runs ships with the extension itself.

**What user data do you plan to collect?**
None of the listed categories. The extension only reads public card listings
and prices from eBay. The token the user pastes is theirs, stored locally,
and used solely to call eBay's API on their behalf. No personal data is
collected.

**Privacy policy URL**
https://mrfentmen.github.io/privacy-policies/sports-card-ticker.html

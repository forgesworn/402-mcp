# [3.10.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.9.1...v3.10.0) (2026-03-16)


### Features

* parse pricing, auth, and timeout from capability content ([bbaf0e0](https://github.com/TheCryptoDonkey/402-mcp/commit/bbaf0e0f379a9ac5bbcc2cfe116e4d1dac53b979))

## [3.9.1](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.9.0...v3.9.1) (2026-03-15)


### Bug Fixes

* improve credits-exhausted message with actionable guidance ([06aa3bd](https://github.com/TheCryptoDonkey/402-mcp/commit/06aa3bdbd9a67bb5a69d3fd68960a5de80de11e2))

# [3.9.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.8.1...v3.9.0) (2026-03-15)


### Features

* surface pricing tiers in 402 responses ([3d176d4](https://github.com/TheCryptoDonkey/402-mcp/commit/3d176d483c615c2319d3fb269224ff69c43ca09c))

## [3.8.1](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.8.0...v3.8.1) (2026-03-15)


### Bug Fixes

* increase l402_pay poll timeout from 30s to 120s ([47bc450](https://github.com/TheCryptoDonkey/402-mcp/commit/47bc450a203f607cea508f07a38d66aebe5fd082))

# [3.8.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.7.0...v3.8.0) (2026-03-15)


### Features

* add l402_store_token tool for pasting payment page tokens ([1b792c5](https://github.com/TheCryptoDonkey/402-mcp/commit/1b792c5820aa63c86db5e7284885ac3e2f3f7e90))

# [3.7.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.6.0...v3.7.0) (2026-03-15)


### Features

* add server description to guide AI usage naturally ([e787374](https://github.com/TheCryptoDonkey/402-mcp/commit/e78737483363cbec02048b3fb6ef34e54a6512ef))

# [3.6.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.5.1...v3.6.0) (2026-03-15)


### Features

* rewrite tool descriptions for natural AI-driven usage ([9178741](https://github.com/TheCryptoDonkey/402-mcp/commit/917874114999443902d4b01b6089093b1f2b0924))

## [3.5.1](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.5.0...v3.5.1) (2026-03-15)


### Bug Fixes

* update payment messages to guide AI orchestration ([eee7bb8](https://github.com/TheCryptoDonkey/402-mcp/commit/eee7bb861f67bc314da41fd0db72118c7c965d24))

# [3.5.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.4.5...v3.5.0) (2026-03-15)


### Features

* use toll-booth payment page URL for human wallet payments ([edb6044](https://github.com/TheCryptoDonkey/402-mcp/commit/edb6044e901642a309cad2025645bffa7b406b88))

## [3.4.5](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.4.4...v3.4.5) (2026-03-15)


### Bug Fixes

* remove isError from QR responses and use low error correction ([f245fc1](https://github.com/TheCryptoDonkey/402-mcp/commit/f245fc12e049ad4fbd6a350145d7207987e25121))

## [3.4.4](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.4.3...v3.4.4) (2026-03-15)


### Bug Fixes

* use terminal QR type with ANSI colours for scannable output ([8a661ae](https://github.com/TheCryptoDonkey/402-mcp/commit/8a661ae898a1e2b0838c7c16199a9e34866a380e))

## [3.4.3](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.4.2...v3.4.3) (2026-03-15)


### Bug Fixes

* combine QR and JSON in single text block for Claude Code display ([3b5aae5](https://github.com/TheCryptoDonkey/402-mcp/commit/3b5aae534c785b0347362de62a7754204acf5760))

## [3.4.2](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.4.1...v3.4.2) (2026-03-15)


### Bug Fixes

* render QR as separate text block so newlines display in terminals ([c0c8f72](https://github.com/TheCryptoDonkey/402-mcp/commit/c0c8f726668136f7cead173142a933b838291442))

## [3.4.1](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.4.0...v3.4.1) (2026-03-15)


### Bug Fixes

* use even margin for UTF-8 QR to prevent RangeError ([91266a0](https://github.com/TheCryptoDonkey/402-mcp/commit/91266a08a4ac2cc497adc3a1e10e669953b08b91))

# [3.4.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.3.4...v3.4.0) (2026-03-15)


### Features

* include text QR code in payment responses for terminal clients ([051eb78](https://github.com/TheCryptoDonkey/402-mcp/commit/051eb788ad7f0e0f06d5b46b1a0046b88ed3b932))

## [3.3.4](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.3.3...v3.3.4) (2026-03-15)


### Bug Fixes

* show QR code for human wallet when credits are exhausted ([66060ac](https://github.com/TheCryptoDonkey/402-mcp/commit/66060acd38aa11039107ab6aaa33713f4a794a0f))

## [3.3.3](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.3.2...v3.3.3) (2026-03-15)


### Bug Fixes

* return QR code immediately for human wallet instead of blocking ([1092355](https://github.com/TheCryptoDonkey/402-mcp/commit/1092355bea363ac2dfc35abe7d8b7a8560e1acf8))

## [3.3.2](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.3.1...v3.3.2) (2026-03-15)


### Bug Fixes

* deduplicate replaceable events by pubkey + d tag in search ([c4f2c42](https://github.com/TheCryptoDonkey/402-mcp/commit/c4f2c423f92155af82420adf74af520d6a6ebde9))

## [3.3.1](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.3.0...v3.3.1) (2026-03-15)


### Bug Fixes

* gitignore .mcp.json and document all config env vars in CLAUDE.md ([b3bb888](https://github.com/TheCryptoDonkey/402-mcp/commit/b3bb88887dd34043e8ff7c964cb6c3f3be332ac6))

# [3.3.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.2.0...v3.3.0) (2026-03-15)


### Features

* parse and surface capability endpoint field in search results ([26332a4](https://github.com/TheCryptoDonkey/402-mcp/commit/26332a4445f4c08f1d7f968939ca552b01e4dd30))

# [3.2.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.1.4...v3.2.0) (2026-03-15)


### Features

* human wallet QR + poll support in l402_fetch and buy-credits ([bb8f29c](https://github.com/TheCryptoDonkey/402-mcp/commit/bb8f29ca0b7467a883f0fe53810fffa77f6de839))

## [3.1.4](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.1.3...v3.1.4) (2026-03-15)


### Bug Fixes

* block startup when TLS validation is disabled without opt-in ([833720f](https://github.com/TheCryptoDonkey/402-mcp/commit/833720f91ddf03905da54b043a8e0814e7dfbfb5))
* decouple insecure TLS opt-in from SSRF_ALLOW_PRIVATE ([3167f2b](https://github.com/TheCryptoDonkey/402-mcp/commit/3167f2b449907f91498d678f63aa5566f3eafd04))
* don't roll back spend tracker after successful Cashu redeem ([375abc0](https://github.com/TheCryptoDonkey/402-mcp/commit/375abc0bd91d6f92dcc8cd746d576f391f775112))
* enforce spend limits on redeem-cashu tool ([c650066](https://github.com/TheCryptoDonkey/402-mcp/commit/c6500664077cedba4e4f1ca2021fb285230f1568))
* validate NWC preimage format and response pubkey ([17addb5](https://github.com/TheCryptoDonkey/402-mcp/commit/17addb5ee2460629bb62223b3ee0da2aa60c0390))
* validate preimage length in handleFetch, require integer amountSats ([1ecd279](https://github.com/TheCryptoDonkey/402-mcp/commit/1ecd279b9eed6f9265fb4ebe57a1a3b234c2e17b))

## [3.1.3](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.1.2...v3.1.3) (2026-03-15)


### Bug Fixes

* cumulative redirect timeout, NWC preimage type check, CORS warning ([bbe47e9](https://github.com/TheCryptoDonkey/402-mcp/commit/bbe47e9b6f4f5741962925de927b01e5685858da))
* harden relay SSRF guard regex, add nostr-subscribe tests ([7fd217c](https://github.com/TheCryptoDonkey/402-mcp/commit/7fd217caed538db1ad5d817401f3b50f8ec37767))
* only call tryRecord when auto-pay would actually proceed ([34012db](https://github.com/TheCryptoDonkey/402-mcp/commit/34012db02dc507ffb70cdd93cd163f6c9b391616))
* reject amountless invoices in buy-credits ([30a885a](https://github.com/TheCryptoDonkey/402-mcp/commit/30a885a800722f2e9646524e1abd8fd26b384e36))
* reject ws:// relays in production mode to prevent DNS rebinding ([8281b82](https://github.com/TheCryptoDonkey/402-mcp/commit/8281b823f848f51a07c85586afb98f190c804bb7))
* strip IPv6 zone IDs in SSRF guard, add SSRF check for relay connections ([bc69681](https://github.com/TheCryptoDonkey/402-mcp/commit/bc69681d047c5be5d53391321195059e11ea8756))
* verify invoice amount matches requested amount before payment ([b475f1b](https://github.com/TheCryptoDonkey/402-mcp/commit/b475f1b3837a4630befa90f9bfba10b17e6f732b))

## [3.1.2](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.1.1...v3.1.2) (2026-03-14)


### Bug Fixes

* enforce spend limits in handlePay, add error handling to pay and search ([e087490](https://github.com/TheCryptoDonkey/402-mcp/commit/e08749019f026098e55801c3dcc07b2ecef8d2d9))
* reject amountless invoices, roll back spend on wallet exception ([795beaa](https://github.com/TheCryptoDonkey/402-mcp/commit/795beaa3032fdbbc894e513405c7a4901792170d))
* validate preimage length, warn on unencrypted relay connections ([1a96209](https://github.com/TheCryptoDonkey/402-mcp/commit/1a9620919422b844dcfe3828b689bca122715bab))

## [3.1.1](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.1.0...v3.1.1) (2026-03-14)


### Bug Fixes

* encryption key hex validation, directory permissions, log sanitisation ([8dd6fca](https://github.com/TheCryptoDonkey/402-mcp/commit/8dd6fcada3cfeef0e32bf8e7d26dfd2f0a64dc56))
* preserve Cashu token when credential storage fails ([1c544fa](https://github.com/TheCryptoDonkey/402-mcp/commit/1c544facd5d4120a11357d4a394e6c9bbc6daa4d))
* preserve user Authorization header when no L402 credentials exist ([8c3dfa6](https://github.com/TheCryptoDonkey/402-mcp/commit/8c3dfa656abf055eaf923fbcefb408070f89a795))
* remove forcePinHttps — rewriting HTTPS URLs breaks TLS SNI ([80b35f2](https://github.com/TheCryptoDonkey/402-mcp/commit/80b35f20513a282cad00b25f11f1dc60d42716f3))
* retry path uses filtered headers, capture storeCredential return value ([51d9940](https://github.com/TheCryptoDonkey/402-mcp/commit/51d994025facf8927af82b1fc3cdaad5309347a1))
* storeCredential returns boolean, redeem-cashu reports storage failures ([a3425a0](https://github.com/TheCryptoDonkey/402-mcp/commit/a3425a0d20c8531e64baa7566c17b66285ae8c38))
* surface credential storage failure in buy-credits response ([bcdc372](https://github.com/TheCryptoDonkey/402-mcp/commit/bcdc3724997e9f06f7f5e101d6bf161eb5bb0ea1))
* validate all DNS records, block fec0::/10 site-local range ([9af9d76](https://github.com/TheCryptoDonkey/402-mcp/commit/9af9d766c44d9607dd760fae8b863173e523e416))
* validate preimage and macaroon before credential storage, roll back spend on failure ([af1d661](https://github.com/TheCryptoDonkey/402-mcp/commit/af1d66169abd3945099177b8f4f45b17b04952ca))

# [3.1.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v3.0.0...v3.1.0) (2026-03-14)


### Features

* surface status tag in search results, skip DOWN/CLOSED by default ([df2d982](https://github.com/TheCryptoDonkey/402-mcp/commit/df2d982754083a41aa53da2e1f62ed5d9a684103))
* use relay-side tag filters for topic and payment method discovery ([305fe7f](https://github.com/TheCryptoDonkey/402-mcp/commit/305fe7f39d95268e1c058e735eb53b1b1e3d663c))

# [3.0.0](https://github.com/TheCryptoDonkey/402-mcp/compare/v2.1.0...v3.0.0) (2026-03-14)


### Bug Fixes

* update funding link to Strike ([c6b8077](https://github.com/TheCryptoDonkey/402-mcp/commit/c6b807722a2d578dbd1a57695b964195629e9d89))


### Code Refactoring

* rename l402-mcp to 402-mcp ([7bebbe2](https://github.com/TheCryptoDonkey/402-mcp/commit/7bebbe299323eb7f0a05aef5823cf18fea74da56))


### BREAKING CHANGES

* package name, binary, config path (~/.402-mcp/),
and MCP server name all changed from l402-mcp to 402-mcp.

# [2.1.0](https://github.com/TheCryptoDonkey/l402-mcp/compare/v2.0.1...v2.1.0) (2026-03-14)


### Bug Fixes

* security hardening — event verification, accumulation cap, relay validation ([926667e](https://github.com/TheCryptoDonkey/l402-mcp/commit/926667e07ba9094b1fee355b44ba878f2483461f))


### Features

* add l402_search tool for kind 31402 service discovery ([76f4e9d](https://github.com/TheCryptoDonkey/l402-mcp/commit/76f4e9defc4ef76a2074341f9b4315a709391dab))
* register l402_search tool with Nostr relay subscriber ([26e9494](https://github.com/TheCryptoDonkey/l402-mcp/commit/26e9494065ccac1a3a2ad64262e89b10389ba2fe))

## [2.0.1](https://github.com/TheCryptoDonkey/l402-mcp/compare/v2.0.0...v2.0.1) (2026-03-14)


### Bug Fixes

* exclude e2e test from prepublishOnly ([19c3fe4](https://github.com/TheCryptoDonkey/l402-mcp/commit/19c3fe4bcee8be4e1edf237ebe33b8e7a80ed162))

# [2.0.0](https://github.com/TheCryptoDonkey/l402-mcp/compare/v1.0.0...v2.0.0) (2026-03-14)


### Features

* enable npm publishing for v1.0.0 release ([aaa57b2](https://github.com/TheCryptoDonkey/l402-mcp/commit/aaa57b24e4511a40f29c513c21e65b054b4e711b))


### BREAKING CHANGES

* first stable release. Package name l402-mcp is
now published to npm — npx l402-mcp works as documented.

# 1.0.0 (2026-03-14)


### Bug Fixes

* add listSafe() to CredentialStore; use it in credentials tool ([0d5848f](https://github.com/TheCryptoDonkey/l402-mcp/commit/0d5848f24a8ca0d6cfedbacbb31dad747ed21c1b))
* atomic writes and secure file permissions for credential stores ([d4a3466](https://github.com/TheCryptoDonkey/l402-mcp/commit/d4a3466ea58965056ddf141fee4a8674beabfcc0))
* block IPv6 ULA (fc00::/fd00::), unspecified (::), and CGNAT (100.64/10) in SSRF guard ([56ce74d](https://github.com/TheCryptoDonkey/l402-mcp/commit/56ce74ddc98581395f3e424183b9a627276e337b))
* broaden L402 parse regex to accept standard base64 and all network prefixes ([92c91e4](https://github.com/TheCryptoDonkey/l402-mcp/commit/92c91e464b27804fc12aef556ec013272d2d5736))
* complete SpendTracker TOCTOU fix, harden path traversal check ([b0724aa](https://github.com/TheCryptoDonkey/l402-mcp/commit/b0724aa1d26e404e11d6369b9682ae9928e62a04))
* correct Cashu token format for cashu-ts v2 and validate amount before melting ([2e0de29](https://github.com/TheCryptoDonkey/l402-mcp/commit/2e0de29a1c9bd99fb655047ec4897d6bbe0d6d2f))
* correct origin tracking, response field mapping, and discovery mode ([2d1254d](https://github.com/TheCryptoDonkey/l402-mcp/commit/2d1254d988c2d4f0a94eb10a95f1f20493efe4b2))
* credential poisoning prevention — preimage validation, Zod schema hardening ([f507ebd](https://github.com/TheCryptoDonkey/l402-mcp/commit/f507ebd640e68ab83ea66c28457fe43fd80ece56))
* default autoPay to false to prevent unintended spending ([0af1c9e](https://github.com/TheCryptoDonkey/l402-mcp/commit/0af1c9ebb846fce23426ab47d34566e0f027a9c1))
* disable npm publish, exclude e2e test, fetch tags in CI ([5133c6c](https://github.com/TheCryptoDonkey/l402-mcp/commit/5133c6c57be93ad858a4afb1ac210ebe1d209d6f))
* disable trust proxy, sanitise origin in log messages ([a60ad81](https://github.com/TheCryptoDonkey/l402-mcp/commit/a60ad81a1db567f8dabd82033e0a77c4d620d4f7))
* enforce credential TTL on list, listSafe, updateBalance, updateLastUsed ([2ec96fa](https://github.com/TheCryptoDonkey/l402-mcp/commit/2ec96fa5deefc7b3356c560e676ef2ce2f0eeb2c))
* evict stale rate-limit buckets to prevent memory leak ([0cc045a](https://github.com/TheCryptoDonkey/l402-mcp/commit/0cc045a038d3a50b65e25a638157f8bd06de30e8))
* fast-reject oversized responses via Content-Length pre-check ([00e892f](https://github.com/TheCryptoDonkey/l402-mcp/commit/00e892f4ca87c262e75cf7ee4428e54297dfa863))
* harden HTTP transport — reduce health info, enable sessions, add rate limiting ([be125fd](https://github.com/TheCryptoDonkey/l402-mcp/commit/be125fddfce9bb90c6386506d3cac91328d23f87))
* input validation — HTTP method whitelist, negative balance rejection, string length limits ([19e17b6](https://github.com/TheCryptoDonkey/l402-mcp/commit/19e17b615f03839e3c490bfdf36388267f3c67db))
* migrate NWC wallet from NIP-04 to NIP-44 encryption ([c8b6967](https://github.com/TheCryptoDonkey/l402-mcp/commit/c8b6967a975189f01d4ce3bc6c10105391871b30))
* prevent NWC secret leakage in error paths ([c32c8e8](https://github.com/TheCryptoDonkey/l402-mcp/commit/c32c8e8e1afbc1a49580d54c9d60d5fa1ac586fe))
* remove plan docs from public repo ([661db94](https://github.com/TheCryptoDonkey/l402-mcp/commit/661db94a2d2371c08d611f2e767319d524fa4b36))
* restrict CORS and bind address; add HTTP transport warning; fix Blob type ([f3fc5c8](https://github.com/TheCryptoDonkey/l402-mcp/commit/f3fc5c80f8e70b067c1471de4788e19907c5e10f))
* sanitise error output, filter response headers, remove preimage from tool responses ([783929f](https://github.com/TheCryptoDonkey/l402-mcp/commit/783929feee2342ed0f023052cc1e60c296005af6))
* security hardening — buy-credits TOCTOU, HTTP headers, preimage validation ([1f4a5e9](https://github.com/TheCryptoDonkey/l402-mcp/commit/1f4a5e9adb384fd82974ece91a1276656537d6e6))
* security hardening — error sanitisation, path validation, memory bounds ([8dbd019](https://github.com/TheCryptoDonkey/l402-mcp/commit/8dbd0194e024535167efd20502b6edecfaf742ea))
* security hardening — SSRF bypass, Cashu fund loss, encryption race, NWC validation ([6743320](https://github.com/TheCryptoDonkey/l402-mcp/commit/6743320dfc079a48d4b1599c6f17424203b3dfe6))
* security hardening and production readiness ([e3e635b](https://github.com/TheCryptoDonkey/l402-mcp/commit/e3e635b59f1fb10105ff4f6ef79b6940a64d6ae4))
* serialise Cashu payment attempts to prevent token consumption race ([d8484b1](https://github.com/TheCryptoDonkey/l402-mcp/commit/d8484b14f531dd84a937d4bbdd7f7516cb6e5d9e))
* surface keytar fallback warning with key source metadata ([ed7c32f](https://github.com/TheCryptoDonkey/l402-mcp/commit/ed7c32f0b13ff9d8496644ec88ec04271810df37))
* tighten L402 header parsing to strict charset validation ([4124393](https://github.com/TheCryptoDonkey/l402-mcp/commit/41243935f7a1a1a2f240af160cd6e399cfb80391))
* validate hexToBytes input and zeroise NWC secret after key derivation ([83d4689](https://github.com/TheCryptoDonkey/l402-mcp/commit/83d4689f7aeecdea0626ccb77ad6eeecb3d7e063))
* validate paymentHash format (64-char hex) before caching challenges ([36bf0d8](https://github.com/TheCryptoDonkey/l402-mcp/commit/36bf0d80b6024226b1cf89dcb1ca8713a2a0fc8c))
* validate server responses before trusting in buy-credits and redeem-cashu ([3343e5a](https://github.com/TheCryptoDonkey/l402-mcp/commit/3343e5adc4a84095d05d835541e0c87ace09e32a))
* validate server responses with Zod in buy-credits and redeem-cashu ([576bddb](https://github.com/TheCryptoDonkey/l402-mcp/commit/576bddbf55c11d29a5d98ce2aa0f56e69eb3dffc))
* wire up human wallet settlement polling in l402_pay tool ([3371618](https://github.com/TheCryptoDonkey/l402-mcp/commit/3371618ef0246b091430c9feecd6d418565679a5))


### Features

* add encryption module with AES-256-GCM and keychain key management ([0cd33e1](https://github.com/TheCryptoDonkey/l402-mcp/commit/0cd33e1113579f992f802911f84e4da268aa0cbb))
* add env var range validation at startup ([48a7708](https://github.com/TheCryptoDonkey/l402-mcp/commit/48a770862fbc92e640c6296d337d5ea480333755))
* add fetch timeout, retry, and SSRF config options ([20a334e](https://github.com/TheCryptoDonkey/l402-mcp/commit/20a334e53067d9f54e969b5dd29733355236fe6f))
* add lazy credential invalidation on 402 re-challenge ([1798b78](https://github.com/TheCryptoDonkey/l402-mcp/commit/1798b7815a6ec66edc955c50c3752d8475af696c))
* add resilient fetch wrapper with timeout, retry, and SSRF redirect following ([341754d](https://github.com/TheCryptoDonkey/l402-mcp/commit/341754df809143142e46bd97532813ec2fab2869))
* add response body size limit to resilient fetch ([ce4cf3f](https://github.com/TheCryptoDonkey/l402-mcp/commit/ce4cf3f152b2c744b89f8f2da842b9a70d59a0d0))
* add ResponseTooLargeError and DowngradeError types ([6cec637](https://github.com/TheCryptoDonkey/l402-mcp/commit/6cec6372733c7997ea160e99b8b9fcda6f20957c))
* add SSRF guard with DNS resolution and IP blocklist ([c989b72](https://github.com/TheCryptoDonkey/l402-mcp/commit/c989b726d79f34d7f3d7fb077b54d6e7847cbdd3))
* add SsrfError, TimeoutError, RetryExhaustedError classes ([0db56b4](https://github.com/TheCryptoDonkey/l402-mcp/commit/0db56b4ab9109822da55a5ab9517b4cf13a76120))
* add subpath exports for programmatic tool handler imports ([72ea83b](https://github.com/TheCryptoDonkey/l402-mcp/commit/72ea83bdb8e9fc5b155247081baf4e466728b86e))
* block HTTPS-to-HTTP downgrade in redirect following ([11bde74](https://github.com/TheCryptoDonkey/l402-mcp/commit/11bde744bf390cd4ee3190e8e392738767bf82bc))
* disable retry on money-mutating POSTs and polling fetches ([8d7f782](https://github.com/TheCryptoDonkey/l402-mcp/commit/8d7f782248ff35dbfb7cbe6a0775c75ad69646e0))
* encrypt Cashu token store at rest; wire init() in entrypoint ([ef9c349](https://github.com/TheCryptoDonkey/l402-mcp/commit/ef9c349e2bec40b72ad719ecb121ea3994f1094e))
* encrypt credential store at rest with AES-256-GCM ([e91e917](https://github.com/TheCryptoDonkey/l402-mcp/commit/e91e917d35968ffeec2b9caefcb5375417d4cdde))
* initial implementation of l402-mcp ([2b45c03](https://github.com/TheCryptoDonkey/l402-mcp/commit/2b45c03d51993209a4f40ed221127618df276873))
* move settlement polling into HumanWallet with exponential backoff ([e4d4349](https://github.com/TheCryptoDonkey/l402-mcp/commit/e4d4349e4f3b2d1f945a573643553dd11bfcccca))
* wire resilient fetch into all tool registrations ([f82a5b3](https://github.com/TheCryptoDonkey/l402-mcp/commit/f82a5b332de4b2337c1beed0564bdf96aaf4d1c4))

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

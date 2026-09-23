# Mission

**402-mcp exists to give AI agents a wallet and the intelligence to use it — so they can discover, pay for, and consume any API on the internet without human registration, API keys, or middlemen.**

Today, when an AI agent needs data from a paid API, a human has to sign up, generate credentials, paste them into a config file, and hope the billing model fits. The agent is powerful but economically helpless.

402-mcp changes that. It speaks the L402 protocol natively, carries its own payment methods, and makes autonomous purchasing decisions within human-set safety limits. The agent discovers a service, reads the price, pays the invoice, and gets the data — all inside a single tool call.

402-mcp is the client side of a machine-to-machine commerce stack. On the server side, [toll-booth](https://github.com/forgesworn/toll-booth) makes any API payable, and [satgate](https://github.com/TheCryptoDonkey/satgate) monetises AI inference specifically. Together they enable a world where agents pay for the services they need, operators earn from the services they provide, and no one needs permission from a platform in between.

We believe:

- **Agents should be economic actors.** Not proxies for human credentials. Not dependents on pre-provisioned API keys. Autonomous participants in a marketplace.
- **The human stays in control.** Safety caps, payment method selection, and credential visibility are human decisions. The agent operates within those boundaries, not around them.
- **Protocol loyalty, not server loyalty.** 402-mcp works with any L402-compliant server — toll-booth, Aperture, or any future implementation.
- **Several payment rails are better than one.** NWC for Lightning wallets, Cashu for ecash, LNURLcash bearer notes, and human-in-the-loop as a fallback. The agent picks the best option for each situation.
- **Privacy first.** Credentials stored locally and encrypted. No accounts, no tracking, no analytics, and no 402-mcp server. Discovery does reach public Nostr relays, and unresolvable host names go to a Handshake resolver; the README lists what goes where.
- **The best agent infrastructure is invisible.** One `npx` command. No configuration required to start. Add a wallet URI when you're ready for autonomy.

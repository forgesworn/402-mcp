import type { WalletMethod, WalletProvider } from './types.js'

/** Selects a wallet provider by preferred method, or returns the first available one. */
export function resolveWallet(
  providers: WalletProvider[],
  preferredMethod?: WalletMethod,
): WalletProvider | undefined {
  if (preferredMethod) {
    return providers.find(p => p.method === preferredMethod && p.available)
  }
  return providers.find(p => p.available)
}

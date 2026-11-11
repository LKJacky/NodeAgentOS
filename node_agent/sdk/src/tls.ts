/** The one TLS switch every TypeScript bus client reads.
 *
 * Node's global WebSocket offers no per-connection certificate option, so the only place to turn
 * verification off is the process-wide switch undici and tls.connect both honour:
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`. It is read before the first dial, which is why this runs in
 * `connect()` rather than at import time: an entry may set the flag after loading the SDK.
 */
export function allowInsecureTls(): void {
  if (process.env.NODE_AGENT_TLS_INSECURE === '1') {
    // Test only. The Python client has the same switch, set in link.py.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
}

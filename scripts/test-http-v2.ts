import { runProtocolSmoke } from './test-http-protocol.ts';

// Exercise the request-scoped 2026-07-28 server/discover path explicitly.
await runProtocolSmoke({ expectedEra: 'modern' });

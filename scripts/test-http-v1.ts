import { runProtocolSmoke } from './test-http-protocol.ts';

// Exercise the 2025-era initialize/session path explicitly.
await runProtocolSmoke({ expectedEra: 'legacy' });

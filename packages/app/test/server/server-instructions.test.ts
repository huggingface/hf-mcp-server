import { describe, expect, it } from 'vitest';
import { buildServerInstructions, SERVER_INSTRUCTIONS_CORE } from '../../src/server/server-instructions.js';

const ANONYMOUS_USER_INFO =
	'The Hugging Face tools are being used anonymously and rate limits apply. ' +
	'Direct the User to set their HF_TOKEN (instructions at https://hf.co/settings/mcp/), or ' +
	'create an account at https://hf.co/join for higher limits.';

describe('server instructions', () => {
	it('is a single short behavioural line with auth context appended', () => {
		const instructions = buildServerInstructions(ANONYMOUS_USER_INFO);
		expect(SERVER_INSTRUCTIONS_CORE).not.toContain('\n');
		// Clients copy instructions into every tool's search entry; keep them small.
		expect(Buffer.byteLength(SERVER_INSTRUCTIONS_CORE, 'utf8')).toBeLessThan(200);
		expect(instructions.startsWith(SERVER_INSTRUCTIONS_CORE)).toBe(true);
		expect(instructions).toContain(ANONYMOUS_USER_INFO);
		expect(SERVER_INSTRUCTIONS_CORE).toContain('hf_fs');
		expect(SERVER_INSTRUCTIONS_CORE.toLowerCase()).toContain('web search');
	});
});

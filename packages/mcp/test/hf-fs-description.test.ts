import { describe, expect, it } from 'vitest';
import { HF_FS_DESCRIPTION } from '../src/hf-fs-contract.js';

describe('hf_fs description', () => {
	it('leads with the vocabulary models search for', () => {
		const firstLine = HF_FS_DESCRIPTION.split('\n')[0] ?? '';
		for (const term of ['trending', 'papers', 'list', 'model and dataset cards', 'README', 'license']) {
			expect(firstLine).toContain(term);
		}
	});

	it('carries the hf:// URL conversion guidance moved out of the server instructions', () => {
		expect(HF_FS_DESCRIPTION).toContain('https://huggingface.co[/datasets|/spaces]/OWNER/NAME/resolve/main/PATH');
		expect(HF_FS_DESCRIPTION).toContain('URL-encode each path segment');
	});
});

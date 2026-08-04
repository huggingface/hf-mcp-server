import { describe, expect, it } from 'vitest';
import {
	ALL_BUILTIN_TOOL_IDS,
	CREATE_REPO_TOOL_ID,
	DYNAMIC_SPACE_TOOL_ID,
	HF_FS_TOOL_ID,
	HF_JOBS_TOOL_ID,
	HUB_REPO_DETAILS_TOOL_ID,
	REPO_SEARCH_TOOL_ID,
} from './tool-ids.js';

describe('built-in tool IDs', () => {
	it('uses the tool ID exposed by the upstream MCP settings API', () => {
		expect(CREATE_REPO_TOOL_ID).toBe('create_repo');
	});

	it('contains the supported core tool surface', () => {
		expect(ALL_BUILTIN_TOOL_IDS).toEqual(
			expect.arrayContaining([
				REPO_SEARCH_TOOL_ID,
				CREATE_REPO_TOOL_ID,
				HUB_REPO_DETAILS_TOOL_ID,
				HF_FS_TOOL_ID,
				HF_JOBS_TOOL_ID,
				DYNAMIC_SPACE_TOOL_ID,
			])
		);
	});

	it('does not contain retired tool IDs', () => {
		for (const retiredToolId of [
			'model_search',
			'dataset_search',
			'model_details',
			'dataset_details',
			'paper_search',
			'hf_doc_search',
			'hf_doc_fetch',
			'space_search',
			'duplicate_space',
			'space_info',
			'space_files',
			'use_space',
		]) {
			expect(ALL_BUILTIN_TOOL_IDS).not.toContain(retiredToolId);
		}
	});
});

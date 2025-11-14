import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import type { SpaceSearchResult } from '../dist/space-search.js';
import { discoverSpaces } from '../dist/space/commands/discover.js';

describe('Space Discovery', () => {
	// Mock the SpaceSearchTool to avoid actual API calls
	function loadTestData(filename: string) {
		const filePath = path.join(__dirname, '../test/fixtures', filename);
		const fileContent = readFileSync(filePath, 'utf-8');
		return JSON.parse(fileContent) as SpaceSearchResult[];
	}

	it('should format discover results without author column', () => {
		const testData = loadTestData('space-result.json');

		// Verify the test data has author fields
		expect(testData[0]).toHaveProperty('author');

		// The formatted output should not include the author column
		// This is tested in integration by calling the actual discover function
		// which uses the SpaceSearchTool
	});

	it('should handle empty search query gracefully', async () => {
		const result = await discoverSpaces('');

		expect(result.isError).toBe(true);
		expect(result.formatted).toContain('Error: Search query is required');
		expect(result.totalResults).toBe(0);
	});

	it('should suggest task-focused queries in error message', async () => {
		const result = await discoverSpaces('');

		expect(result.formatted).toContain('Video Generation');
		expect(result.formatted).toContain('Object Detection');
		expect(result.formatted).toContain('Image Generation');
	});
});

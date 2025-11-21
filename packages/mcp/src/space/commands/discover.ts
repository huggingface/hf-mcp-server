import type { ToolResult } from '../../types/tool-result.js';
import { escapeMarkdown } from '../../utilities.js';

/**
 * Prompt configuration for discover operation
 * Easy to edit for prompt optimization
 */
export const DISCOVER_PROMPTS = {
	// Header for the discover results
	RESULTS_HEADER: `# Available Spaces

These Spaces can be invoked using the \`dynamic_space\` tool.
Use \`"operation": "view_parameters"\` to inspect a space's parameters before invoking.

`,

	// No results message
	NO_RESULTS: `No spaces available in the dynamic spaces list.`,

	// Error fetching data
	FETCH_ERROR: (url: string, error: string) =>
		`Error fetching dynamic spaces from ${url}: ${error}`,
};

/**
 * Discovers available spaces from a dynamic URL (CSV format)
 *
 * Expected CSV format:
 * space_id,category,description
 *
 * @returns Formatted discover results as markdown table
 */
export async function discoverSpaces(): Promise<ToolResult> {
	const dynamicUrl = process.env.DYNAMIC_SPACE_DATA;

	if (!dynamicUrl) {
		return {
			formatted: 'Error: DYNAMIC_SPACE_DATA environment variable not set',
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}

	try {
		const response = await fetch(dynamicUrl);

		if (!response.ok) {
			return {
				formatted: DISCOVER_PROMPTS.FETCH_ERROR(dynamicUrl, `HTTP ${response.status}`),
				totalResults: 0,
				resultsShared: 0,
				isError: true,
			};
		}

		const csvContent = await response.text();
		const spaces = parseCSV(csvContent);

		if (spaces.length === 0) {
			return {
				formatted: DISCOVER_PROMPTS.NO_RESULTS,
				totalResults: 0,
				resultsShared: 0,
			};
		}

		return formatDiscoverResults(spaces);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			formatted: DISCOVER_PROMPTS.FETCH_ERROR(dynamicUrl, errorMessage),
			totalResults: 0,
			resultsShared: 0,
			isError: true,
		};
	}
}

/**
 * Parse CSV content into space entries
 * Expected format: space_id,category,"description"
 */
function parseCSV(content: string): Array<{ id: string; category: string; description: string }> {
	const lines = content.trim().split('\n');
	const spaces: Array<{ id: string; category: string; description: string }> = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		// Parse CSV line handling quoted fields
		const fields = parseCSVLine(line);
		if (fields.length >= 3) {
			const id = fields[0];
			const category = fields[1];
			const description = fields[2];
			if (id && category && description) {
				spaces.push({
					id: id.trim(),
					category: category.trim(),
					description: description.trim(),
				});
			}
		}
	}

	return spaces;
}

/**
 * Parse a single CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];

		if (char === '"') {
			inQuotes = !inQuotes;
		} else if (char === ',' && !inQuotes) {
			fields.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	fields.push(current);

	return fields;
}

/**
 * Format discover results as a markdown table
 */
function formatDiscoverResults(
	spaces: Array<{ id: string; category: string; description: string }>
): ToolResult {
	let markdown = DISCOVER_PROMPTS.RESULTS_HEADER;

	// Table header
	markdown += '| Space ID | Category | Description |\n';
	markdown += '|----------|----------|-------------|\n';

	// Table rows
	for (const space of spaces) {
		markdown +=
			`| \`${escapeMarkdown(space.id)}\` ` +
			`| ${escapeMarkdown(space.category)} ` +
			`| ${escapeMarkdown(space.description)} |\n`;
	}

	return {
		formatted: markdown,
		totalResults: spaces.length,
		resultsShared: spaces.length,
	};
}

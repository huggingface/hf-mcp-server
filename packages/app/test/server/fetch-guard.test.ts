import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_ROOT = join(process.cwd(), 'src', 'server');

function collectTsFiles(root: string): string[] {
	const entries = readdirSync(root);
	const files: string[] = [];

	for (const entry of entries) {
		const fullPath = join(root, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			files.push(...collectTsFiles(fullPath));
			continue;
		}

		if (fullPath.endsWith('.ts')) {
			files.push(fullPath);
		}
	}

	return files;
}

function hasDirectFetchCall(content: string): boolean {
	const regex = /fetch\s*\(/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(content)) !== null) {
		const index = match.index;
		const previousChar = index > 0 ? content[index - 1] : '';

		if (/[\w$.]/.test(previousChar)) {
			continue;
		}

		const prefix = content.slice(Math.max(0, index - 20), index);
		if (/\basync\s+$/.test(prefix) || /\bfunction\s+$/.test(prefix)) {
			continue;
		}

		return true;
	}

	return false;
}

describe('server fetch usage guard', () => {
	it('does not allow direct fetch calls in server source', () => {
		const ignoredSuffixes = new Set(['/resources/gradio-widget-content.ts']);
		const offenders: string[] = [];
		const files = collectTsFiles(SERVER_ROOT);

		for (const file of files) {
			const relative = file.replace(SERVER_ROOT, '').replace(/\\/g, '/');
			if (ignoredSuffixes.has(relative)) {
				continue;
			}

			const content = readFileSync(file, 'utf8');
			if (hasDirectFetchCall(content)) {
				offenders.push(relative);
			}
		}

		expect(offenders).toEqual([]);
	});
});

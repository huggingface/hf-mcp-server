const SYMBOL_CONTEXT_BEFORE = 3_000;
const SYMBOL_CONTEXT_AFTER = 9_000;
const DOC_BUILDER_MARKER_RE = /\[\[([^\]]+)\]\]/g;

type MarkdownSectionMatch = 'marker' | 'heading' | 'symbol';

interface MarkdownSection {
	content: string;
	heading?: string;
	match: MarkdownSectionMatch;
}

interface MarkdownHeading {
	start: number;
	end: number;
	level: number;
	text: string;
	markers: string[];
}

export function extractMarkdownSection(markdown: string, anchor: string): MarkdownSection | undefined {
	const target = anchor.trim().replace(/^#/, '');
	if (!target) return undefined;

	const headings = markdownHeadings(markdown);
	const marker = headings.find((heading) =>
		heading.markers.some((candidate) => candidate.toLocaleLowerCase() === target.toLocaleLowerCase())
	);
	if (marker) return headingSection(markdown, headings, marker, 'marker');

	const normalizedTarget = normalizeAnchor(target);
	const heading = headings.find((candidate) => normalizeAnchor(candidate.text) === normalizedTarget);
	if (heading) return headingSection(markdown, headings, heading, 'heading');

	const symbol = target.slice(target.lastIndexOf('.') + 1);
	const matchAt = findSymbol(markdown, symbol);
	if (matchAt === -1) return undefined;

	const containingHeading = [...headings].reverse().find((candidate) => candidate.start <= matchAt);
	const start = lineBoundary(markdown, Math.max(containingHeading?.end ?? 0, matchAt - SYMBOL_CONTEXT_BEFORE), -1);
	const end = lineBoundary(markdown, Math.min(markdown.length, matchAt + SYMBOL_CONTEXT_AFTER), 1);
	const content = markdown.slice(start, end).trim();
	return content
		? {
				content,
				...(containingHeading ? { heading: visibleHeading(containingHeading.text) } : {}),
				match: 'symbol',
			}
		: undefined;
}

function markdownHeadings(markdown: string): MarkdownHeading[] {
	const headings: MarkdownHeading[] = [];
	let offset = 0;
	let fence: string | undefined;
	for (const line of markdown.split(/(?<=\n)/)) {
		const text = line.replace(/\r?\n$/, '');
		const fenceMatch = text.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1]?.[0];
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
		} else if (!fence) {
			const match = text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
			if (match?.[1] && match[2]) {
				headings.push({
					start: offset,
					end: offset + line.length,
					level: match[1].length,
					text: match[2],
					markers: [...match[2].matchAll(DOC_BUILDER_MARKER_RE)].flatMap((markerMatch) =>
						markerMatch[1] ? [markerMatch[1]] : []
					),
				});
			}
		}
		offset += line.length;
	}
	return headings;
}

function headingSection(
	markdown: string,
	headings: MarkdownHeading[],
	heading: MarkdownHeading,
	match: Exclude<MarkdownSectionMatch, 'symbol'>
): MarkdownSection {
	const index = headings.indexOf(heading);
	const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
	return {
		content: markdown.slice(heading.start, next?.start ?? markdown.length).trim(),
		heading: visibleHeading(heading.text),
		match,
	};
}

function visibleHeading(value: string): string {
	return value.replace(DOC_BUILDER_MARKER_RE, '').trim();
}

function normalizeAnchor(value: string): string {
	return value
		.normalize('NFKD')
		.toLocaleLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function findSymbol(markdown: string, symbol: string): number {
	if (!symbol) return -1;
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return markdown.search(new RegExp(`(^|[^\\p{Letter}\\p{Number}_])${escaped}(?=$|[^\\p{Letter}\\p{Number}_])`, 'u'));
}

function lineBoundary(value: string, offset: number, direction: -1 | 1): number {
	if (offset <= 0) return 0;
	if (offset >= value.length) return value.length;
	const newline = direction === -1 ? value.lastIndexOf('\n', offset) : value.indexOf('\n', offset);
	return newline === -1 ? (direction === -1 ? 0 : value.length) : newline + 1;
}

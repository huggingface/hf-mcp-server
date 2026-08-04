import { readFile } from 'node:fs/promises';

import type { HfFsCatResult, HfFsStatResult } from './hf-fs.js';

type HfFsGuidanceKind = 'root' | 'papers';

const GUIDANCE_URLS = {
	root: new URL('../content/hf-fs/README.md', import.meta.url),
	papers: new URL('../content/hf-fs/papers.md', import.meta.url),
} as const;

const guidanceCache = new Map<HfFsGuidanceKind, Promise<string>>();

export function isRootGuidanceUri(uri: string): boolean {
	return uri === 'hf://README.md';
}

export async function catGuidance(
	kind: HfFsGuidanceKind,
	uri: string,
	path: string,
	offset: number,
	maxBytes: number
): Promise<HfFsCatResult> {
	const content = await loadGuidance(kind);
	const range = sliceUtf8(content, offset, maxBytes);
	return {
		uri,
		op: 'cat',
		path,
		content: range.content,
		content_type: 'text/markdown',
		bytes: range.bytes,
		truncated: range.truncated,
		...(range.truncated ? { truncation_reason: 'max_bytes', next_offset: range.nextOffset } : {}),
	};
}

export async function statGuidance(kind: HfFsGuidanceKind, uri: string, path: string): Promise<HfFsStatResult> {
	const content = await loadGuidance(kind);
	return {
		uri,
		op: 'stat',
		exists: true,
		type: 'file',
		path,
		content_type: 'text/markdown',
		size: new TextEncoder().encode(content).byteLength,
	};
}

async function loadGuidance(kind: HfFsGuidanceKind): Promise<string> {
	const cached = guidanceCache.get(kind);
	if (cached) {
		return await cached;
	}
	const promise = readFile(GUIDANCE_URLS[kind], 'utf8');
	guidanceCache.set(kind, promise);
	try {
		return await promise;
	} catch (error) {
		guidanceCache.delete(kind);
		throw error;
	}
}

interface Utf8Slice {
	content: string;
	bytes: number;
	truncated: boolean;
	nextOffset?: number;
}

export function sliceUtf8(content: string, offset: number, maxBytes: number): Utf8Slice {
	const encoded = new TextEncoder().encode(content);
	if (offset >= encoded.byteLength || maxBytes === 0) {
		return {
			content: '',
			bytes: 0,
			truncated: offset < encoded.byteLength,
			...(offset < encoded.byteLength ? { nextOffset: offset } : {}),
		};
	}

	let start = offset;
	while (start > 0 && isContinuationByte(encoded[start])) {
		start -= 1;
	}
	let end = Math.min(offset + maxBytes, encoded.byteLength);
	while (end < encoded.byteLength && isContinuationByte(encoded[end])) {
		end += 1;
	}
	const bytes = encoded.slice(start, end);
	return {
		content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		bytes: bytes.byteLength,
		truncated: end < encoded.byteLength,
		...(end < encoded.byteLength ? { nextOffset: end } : {}),
	};
}

function isContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

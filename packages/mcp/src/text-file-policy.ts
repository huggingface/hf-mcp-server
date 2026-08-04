import path from 'node:path';
import { lookup as lookupMimeType } from 'mime-types';

const MAX_CONTROL_CHARACTER_RATIO = 0.02;
const MAX_CONTROL_CHARACTER_COUNT = 8;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const TEXT_FILENAMES = new Set([
	'.dockerignore',
	'.env',
	'.gitattributes',
	'.gitignore',
	'.gitmodules',
	'authors',
	'citation',
	'contributing',
	'copying',
	'dockerfile',
	'license',
	'notice',
	'readme',
]);

// Keep extension overrides limited to cases mime-types does not know or maps to a misleading non-text type.
const TEXT_EXTENSION_OVERRIDES = new Set([
	'.adoc',
	'.bat',
	'.cfg',
	'.cjs',
	'.cmake',
	'.cs',
	'.cts',
	'.cu',
	'.cuh',
	'.dockerfile',
	'.env',
	'.go',
	'.hpp',
	'.ipynb',
	'.jl',
	'.jsonl',
	'.kt',
	'.lock',
	'.mts',
	'.ndjson',
	'.patch',
	'.properties',
	'.ps1',
	'.py',
	'.r',
	'.rb',
	'.rst',
	'.scala',
	'.swift',
	'.ts',
	'.tsx',
]);

// Hub ML artifact formats are often unknown to mime-types, but are not safe to return through text cat.
const BINARY_EXTENSION_OVERRIDES = new Set([
	'.arrow',
	'.avro',
	'.ckpt',
	'.feather',
	'.ggml',
	'.gguf',
	'.h5',
	'.h5ad',
	'.hdf5',
	'.joblib',
	'.keras',
	'.model',
	'.npy',
	'.npz',
	'.onnx',
	'.orc',
	'.parquet',
	'.pb',
	'.pickle',
	'.pkl',
	'.pt',
	'.pth',
	'.safetensors',
	'.tflite',
	'.tgz',
	'.zst',
]);

const TEXT_APPLICATION_MIME_TYPES = new Set([
	'application/ecmascript',
	'application/javascript',
	'application/json',
	'application/ld+json',
	'application/node',
	'application/toml',
	'application/typescript',
	'application/x-httpd-php',
	'application/x-javascript',
	'application/x-ndjson',
	'application/x-perl',
	'application/x-sh',
	'application/x-sql',
	'application/x-tex',
	'application/x-yaml',
	'application/xhtml+xml',
	'application/xml',
	'application/yaml',
]);

const BINARY_MIME_TYPES = new Set([
	'application/gzip',
	'application/java-archive',
	'application/msword',
	'application/octet-stream',
	'application/pdf',
	'application/vnd.ms-excel',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/x-7z-compressed',
	'application/x-bzip2',
	'application/x-hdf5',
	'application/x-msdownload',
	'application/x-msdos-program',
	'application/x-rar-compressed',
	'application/x-tar',
	'application/x-xz',
	'application/zip',
]);

type TextFilePathPolicy = 'text' | 'binary' | 'unknown';

export function assertTextFilePath(filePath: string): void {
	if (classifyTextFilePath(filePath) === 'binary') {
		throw nonTextFileError(filePath, 'The file extension or MIME type is known to be binary.');
	}
}

export function decodeTextFileContent(filePath: string, bytes: Uint8Array): string {
	assertTextFilePath(filePath);
	if (bytes.includes(0)) {
		throw nonTextFileError(filePath, 'The downloaded byte range contains NUL bytes.');
	}

	let text: string;
	try {
		text = UTF8_DECODER.decode(bytes);
	} catch {
		throw nonTextFileError(filePath, 'The downloaded byte range is not valid UTF-8 text.');
	}

	if (hasBinaryControlCharacters(text)) {
		throw nonTextFileError(filePath, 'The decoded content contains too many control characters.');
	}

	return text;
}

export function classifyTextFilePath(filePath: string): TextFilePathPolicy {
	const extension = path.extname(filePath).toLowerCase();
	const basename = path.basename(filePath).toLowerCase();

	if (BINARY_EXTENSION_OVERRIDES.has(extension)) {
		return 'binary';
	}
	if (TEXT_EXTENSION_OVERRIDES.has(extension) || TEXT_FILENAMES.has(basename)) {
		return 'text';
	}

	const mimeType = lookupMimeType(filePath);
	if (!mimeType) {
		return 'unknown';
	}
	if (isTextMimeType(mimeType)) {
		return 'text';
	}
	if (isBinaryMimeType(mimeType)) {
		return 'binary';
	}
	return 'unknown';
}

function isTextMimeType(mimeType: string): boolean {
	const normalized = mimeType.toLowerCase();
	return (
		normalized.startsWith('text/') ||
		TEXT_APPLICATION_MIME_TYPES.has(normalized) ||
		normalized.endsWith('+json') ||
		normalized.endsWith('+xml') ||
		normalized.endsWith('+yaml')
	);
}

function isBinaryMimeType(mimeType: string): boolean {
	const normalized = mimeType.toLowerCase();
	return (
		normalized.startsWith('audio/') ||
		normalized.startsWith('font/') ||
		normalized.startsWith('image/') ||
		normalized.startsWith('video/') ||
		BINARY_MIME_TYPES.has(normalized)
	);
}

function hasBinaryControlCharacters(text: string): boolean {
	let controlCharacters = 0;
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code === 9 || code === 10 || code === 12 || code === 13) {
			continue;
		}
		if (code < 32 || code === 127) {
			controlCharacters += 1;
		}
	}

	return (
		controlCharacters > MAX_CONTROL_CHARACTER_COUNT &&
		controlCharacters / Math.max(text.length, 1) > MAX_CONTROL_CHARACTER_RATIO
	);
}

function nonTextFileError(filePath: string, reason: string): Error {
	return new Error(`Refusing to cat non-text file: ${filePath}. ${reason} Use ls or stat for file metadata.`);
}

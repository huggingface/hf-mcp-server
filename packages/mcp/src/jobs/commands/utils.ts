import { posix } from 'node:path';
import { jobSubmissionLabelsSchema } from '../types.js';
import type { JobSpec, JobVolume, JobVolumeType } from '../types.js';
import { parse as parseShellArgs } from 'shell-quote';

interface EnvToken {
	type: 'env';
	key: string;
}

const SPECIAL_PARAMS = new Set(['*', '@', '#', '?', '!', '-', '_']);
const HF_VOLUME_PREFIX = 'hf://';
const VOLUME_FORMAT_HELP =
	'Expected format: hf://[TYPE/]OWNER/NAME[@REVISION][/PATH]:/MOUNT_PATH[:ro|:rw], ' +
	'e.g. hf://datasets/org/dataset:/data:ro or hf://buckets/org/bucket:/output.';
const HF_VOLUME_TYPES: Record<string, JobVolumeType> = {
	models: 'model',
	datasets: 'dataset',
	spaces: 'space',
	buckets: 'bucket',
};
const SINGULAR_VOLUME_TYPES = new Set(['model', 'dataset', 'space', 'bucket']);
const CONVERT_REVISION_ALIASES: Record<string, string> = {
	'~parquet': 'refs/convert/parquet',
	'~duckdb': 'refs/convert/duckdb',
};
const VOLUME_ID_SEGMENT = /^[\w.-]+$/;

function hasControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function isUnsafeSubpathSegment(segment: string): boolean {
	if (segment === '.' || segment === '..' || segment.includes('\\') || hasControlChars(segment)) {
		return true;
	}
	if (segment.includes('%')) {
		try {
			const decoded = decodeURIComponent(segment);
			if (
				decoded === '.' ||
				decoded === '..' ||
				decoded.includes('/') ||
				decoded.includes('\\') ||
				hasControlChars(decoded)
			) {
				return true;
			}
		} catch {
			// Literal '%' that is not valid percent-encoding is safe as a plain path segment.
		}
	}
	return false;
}

function isEnvToken(entry: unknown): entry is EnvToken {
	return Boolean(entry && typeof entry === 'object' && (entry as EnvToken).type === 'env');
}

function formatEnvReference(key: string): string {
	if (key === '') {
		return '$';
	}

	if (key === '$') {
		return '$$';
	}

	if (/^[A-Za-z0-9_]+$/.test(key)) {
		return `$${key}`;
	}

	if (SPECIAL_PARAMS.has(key)) {
		return `$${key}`;
	}

	return `\${${key}}`;
}

const TIMEOUT_UNITS: Record<string, number> = {
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	d: 86400,
	day: 86400,
	days: 86400,
};

/**
 * Parse a timeout ("5m", "2h", "30s", "1.5h", "30 minutes" or plain seconds "300") to seconds.
 * The whole string must match: "30minutes" is 1800 seconds and "5x" is rejected, never read
 * as a numeric prefix.
 */
export function parseTimeout(timeout: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(timeout);
	const unit = match ? (match[2] ?? '').toLowerCase() : undefined;
	const multiplier = unit === '' ? 1 : unit !== undefined ? TIMEOUT_UNITS[unit] : undefined;
	if (!match?.[1] || multiplier === undefined) {
		throw new Error(`Invalid timeout format: "${timeout}". Use format like "5m", "2h", "30s", or plain seconds.`);
	}
	return Math.floor(parseFloat(match[1]) * multiplier);
}

/**
 * Detect if image is a Space URL and extract spaceId
 * Returns { dockerImage } or { spaceId }
 */
export function parseImageSource(image: string): { dockerImage?: string; spaceId?: string } {
	const spacePrefixes = [
		'https://huggingface.co/spaces/',
		'https://hf.co/spaces/',
		'huggingface.co/spaces/',
		'hf.co/spaces/',
	];

	for (const prefix of spacePrefixes) {
		if (image.startsWith(prefix)) {
			return { spaceId: image.substring(prefix.length) };
		}
	}

	// Not a space, treat as docker image
	return { dockerImage: image };
}

/**
 * Parse command string or array into command array
 * Tokenizes quotes and escaping with shell-quote; does not execute a shell
 */
export function parseCommand(command: string | string[]): { command: string[]; arguments?: string[] } {
	// If already an array, return as-is
	if (Array.isArray(command)) {
		return { command, arguments: [] };
	}

	// Tokenize the command string without expanding environment references
	const parsed = parseShellArgs<EnvToken>(command, (key) => ({ type: 'env', key }));

	// Convert parsed result to string array
	// shell-quote can return various types (strings, objects for operators, etc.)
	// We filter to only keep string arguments
	const stringArgs: string[] = [];
	for (const arg of parsed) {
		if (typeof arg === 'string') {
			stringArgs.push(arg);
		} else if (isEnvToken(arg)) {
			stringArgs.push(formatEnvReference(arg.key));
		} else {
			// If we encounter a non-string (like operators), throw an error
			throw new Error(
				'Unsupported shell syntax in command. Strings tokenize quotes and escaping, not shell execution. ' +
					'Use literal argv arrays for special characters in arguments. ' +
					'For pipes, chaining, redirections, or variable expansion, explicitly use ["/bin/sh", "-lc", "..."] only if the image provides that shell.'
			);
		}
	}

	if (stringArgs.length === 0) {
		throw new Error(`Invalid command: "${command}". Command cannot be empty.`);
	}

	return { command: stringArgs, arguments: [] };
}

function invalidVolume(rawSpec: string, message: string): Error {
	return new Error(`Invalid volume "${rawSpec}". ${message} ${VOLUME_FORMAT_HELP}`);
}

function parseVolume(rawSpec: string): JobVolume {
	let spec = rawSpec;
	let explicitReadOnly: boolean | undefined;

	if (spec.endsWith(':ro')) {
		explicitReadOnly = true;
		spec = spec.slice(0, -3);
	} else if (spec.endsWith(':rw')) {
		explicitReadOnly = false;
		spec = spec.slice(0, -3);
	}

	if (!spec.startsWith(HF_VOLUME_PREFIX)) {
		throw invalidVolume(rawSpec, `Volume source must start with "${HF_VOLUME_PREFIX}".`);
	}

	const body = spec.slice(HF_VOLUME_PREFIX.length);
	const mountSeparator = body.lastIndexOf(':/');
	if (mountSeparator === -1) {
		throw invalidVolume(rawSpec, 'Missing mount path.');
	}

	const sourcePart = body.slice(0, mountSeparator);
	const rawMountPath = body.slice(mountSeparator + 1);
	if (!sourcePart) {
		throw invalidVolume(rawSpec, 'Missing Hub source before mount path.');
	}
	if (!rawMountPath.startsWith('/')) {
		throw invalidVolume(rawSpec, `Mount path must be a non-empty absolute path, got "${rawMountPath}".`);
	}
	if (rawMountPath.includes('\\') || hasControlChars(rawMountPath)) {
		throw invalidVolume(rawSpec, 'Mount path contains invalid characters.');
	}
	if (rawMountPath.split('/').some((seg) => seg === '.' || seg === '..')) {
		throw invalidVolume(rawSpec, 'Mount path must not contain "." or ".." segments.');
	}
	const mountPath = posix.normalize(rawMountPath).replace(/\/+$/, '') || '/';
	if (mountPath === '/') {
		throw invalidVolume(rawSpec, `Mount path must be a non-empty absolute path, got "${rawMountPath}".`);
	}

	const segments = sourcePart.split('/');
	const firstSegment = segments[0];
	if (!firstSegment) {
		throw invalidVolume(rawSpec, 'Missing Hub source type or owner.');
	}
	if (SINGULAR_VOLUME_TYPES.has(firstSegment)) {
		throw invalidVolume(rawSpec, `Type prefix must be plural, got "${firstSegment}/".`);
	}

	const explicitType = HF_VOLUME_TYPES[firstSegment];
	const type = explicitType ?? 'model';
	const locationSegments = explicitType ? segments.slice(1) : segments;
	const owner = locationSegments[0];
	const nameAndRev = locationSegments[1];
	if (!owner || !nameAndRev) {
		throw invalidVolume(rawSpec, 'Hub source must include OWNER/NAME.');
	}

	const atIndex = nameAndRev.indexOf('@');
	const repoName = atIndex >= 0 ? nameAndRev.slice(0, atIndex) : nameAndRev;
	if (
		!repoName ||
		!VOLUME_ID_SEGMENT.test(owner) ||
		!VOLUME_ID_SEGMENT.test(repoName) ||
		owner === '.' ||
		owner === '..' ||
		repoName === '.' ||
		repoName === '..'
	) {
		throw invalidVolume(rawSpec, 'Hub source must include a valid OWNER/NAME.');
	}

	let revision: string | undefined;
	if (atIndex >= 0) {
		if (type === 'bucket') {
			throw invalidVolume(rawSpec, 'Buckets do not support "@revision".');
		}
		const rawRevision = nameAndRev.slice(atIndex + 1);
		if (!rawRevision) {
			throw invalidVolume(rawSpec, 'Revision after "@" cannot be empty.');
		}
		let decodedRevision: string;
		try {
			decodedRevision = decodeURIComponent(rawRevision);
		} catch {
			throw invalidVolume(rawSpec, 'Invalid percent-encoding in "@revision".');
		}
		if (decodedRevision === 'refs') {
			throw invalidVolume(
				rawSpec,
				'Revisions containing "/" (such as "refs/pr/1" or "refs/convert/parquet") must percent-encode slashes as "%2F" (e.g. "@refs%2Fpr%2F1" or "@~parquet").'
			);
		}
		if (
			!decodedRevision.trim() ||
			decodedRevision !== decodedRevision.trim() ||
			decodedRevision.includes('..') ||
			decodedRevision.includes('\\') ||
			hasControlChars(decodedRevision) ||
			decodedRevision.startsWith('/') ||
			decodedRevision.endsWith('/') ||
			decodedRevision.includes('//') ||
			decodedRevision.split('/').some((seg) => seg === '.' || seg === '..')
		) {
			throw invalidVolume(rawSpec, 'Invalid revision in volume source.');
		}
		revision = CONVERT_REVISION_ALIASES[decodedRevision] ?? decodedRevision;
	}

	if (type !== 'bucket' && explicitReadOnly === false) {
		throw invalidVolume(
			rawSpec,
			`Volumes of type "${type}" are read-only; only hf://buckets/... volumes support ":rw" (use forwardHfToken with HfApi to upload to a ${type} repository).`
		);
	}
	const readOnly = type === 'bucket' ? (explicitReadOnly ?? false) : true;

	const rawSubSegments = locationSegments.slice(2).filter(Boolean);
	if (rawSubSegments.some(isUnsafeSubpathSegment)) {
		throw invalidVolume(rawSpec, 'Volume subpath must not contain "." or ".." segments or invalid path characters.');
	}
	const subPath = rawSubSegments.join('/') || undefined;

	const volume: JobVolume = {
		type,
		source: `${owner}/${repoName}`,
		mountPath,
		readOnly,
	};
	if (revision !== undefined) {
		volume.revision = revision;
	}
	if (subPath !== undefined) {
		volume.path = subPath;
	}

	return volume;
}

/**
 * Parse hf:// volume mount strings into the Jobs API payload shape.
 */
export function parseVolumes(volumes?: string[]): JobVolume[] | undefined {
	if (!volumes || volumes.length === 0) {
		return undefined;
	}

	const parsed = volumes.map(parseVolume);
	const seenMountPaths = new Set<string>();
	for (const volume of parsed) {
		const normalized = posix.normalize(volume.mountPath).replace(/\/+$/, '') || '/';
		if (seenMountPaths.has(normalized)) {
			throw new Error(`Invalid volume mount path "${normalized}". Each volume must have a unique mount path.`);
		}
		seenMountPaths.add(normalized);
	}

	return parsed;
}

/**
 * Replace HF token placeholder with actual token if available
 */
function replaceTokenPlaceholder(value: string, hfToken?: string): string {
	if (!hfToken) {
		return value;
	}

	if (value === '$HF_TOKEN' || value === '${HF_TOKEN}') {
		return hfToken;
	}

	return value;
}

function transformEnvMap(
	map: Record<string, string> | undefined,
	hfToken?: string
): Record<string, string> | undefined {
	if (!map) {
		return undefined;
	}

	const transformedEntries = Object.entries(map).map<[string, string]>(([key, value]) => [
		key,
		replaceTokenPlaceholder(value, hfToken),
	]);
	return Object.fromEntries(transformedEntries);
}

/**
 * Create a JobSpec from run command arguments
 */
export function createJobSpec(args: {
	image: string;
	command: string | string[];
	flavor?: string;
	env?: Record<string, string>;
	secrets?: Record<string, string>;
	timeout?: string;
	hfToken?: string;
	volumes?: string[];
	resourceGroupId?: string;
	name?: string;
	labels?: Record<string, string>;
}): JobSpec {
	// Validate required fields
	if (!args.image) {
		throw new Error('image parameter is required. Provide a Docker image (e.g., "python:3.12") or Space URL.');
	}
	if (!args.command) {
		throw new Error('command parameter is required. Provide a command as string or array.');
	}

	const { name, labels } = jobSubmissionLabelsSchema.parse(args);
	const resolvedLabels = name === undefined ? labels : { ...labels, name };
	const imageSource = parseImageSource(args.image);
	const { command, arguments: cmdArgs } = parseCommand(args.command);
	const timeoutSeconds = args.timeout ? parseTimeout(args.timeout) : undefined;
	const environment = transformEnvMap(args.env, args.hfToken) || {};
	const secrets = transformEnvMap(args.secrets, args.hfToken) || {};
	const volumes = parseVolumes(args.volumes);

	const spec: JobSpec = {
		...imageSource,
		command,
		arguments: cmdArgs,
		flavor: args.flavor || 'cpu-basic',
		environment,
		secrets,
		timeoutSeconds,
		...(args.resourceGroupId ? { resourceGroupId: args.resourceGroupId } : {}),
	};
	if (resolvedLabels && Object.keys(resolvedLabels).length > 0) {
		spec.labels = { ...resolvedLabels };
	}
	if (volumes) {
		spec.volumes = volumes;
	}

	return spec;
}

import { logger } from '../utils/logger.js';
import type { MetricsCounter, ProtocolEra } from '../../shared/transport-metrics.js';
import type { SessionMetadata } from '../transport/base-transport.js';
import { remote } from '../cluster/ipc.js';

const MAX_SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MIN_SESSION_SWEEP_INTERVAL_MS = 10 * 1000;
// ~500k expiries take ~260 ms; chunk the work so a backlog never stalls requests for long.
export const MAX_SESSIONS_EXPIRED_PER_PASS = 25_000;

export const DEFAULT_SESSION_IDLE_TTL_HOURS = 24;
export const DEFAULT_SESSION_MAX = 1_000_000;

/**
 * Plain serializable session record returned across IPC or local lookups.
 */
export interface SessionRecord {
	id: string;
	connectedAtMs: number;
	lastActivityMs: number;
	requestCount: number;
	isAuthenticated: boolean;
	ipAddress?: string;
	protocolEra?: ProtocolEra;
	protocolVersion?: string;
	clientCapabilities?: Record<string, unknown>;
	clientInfo?: { name: string; version: string };
	userHash?: string;
}

export interface CreateSessionInput {
	id: string;
	isAuthenticated: boolean;
	ipAddress?: string;
	protocolEra?: ProtocolEra;
	protocolVersion?: string;
	clientCapabilities?: Record<string, unknown>;
	clientInfo?: { name: string; version: string };
	userHash?: string;
}

export interface SessionRegistryOptions {
	metrics: MetricsCounter;
	idleTtlMs?: number;
	maxSessions?: number;
	env?: NodeJS.ProcessEnv;
}

export interface SessionListResult {
	total: number;
	sessions: SessionMetadata[];
}

export interface SessionStore {
	readonly ownsRegistry: boolean;
	create(input: CreateSessionInput): Promise<SessionRecord>;
	peek(id: string): Promise<SessionRecord | undefined>;
	touch(id: string): Promise<SessionRecord | undefined>;
	delete(id: string): Promise<SessionRecord | undefined>;
	getLocalCount(): number;
	getLocalSessions(limit?: number): SessionMetadata[];
	getLocalSessionList(limit?: number): SessionListResult;
	startSweep(): void;
	cleanup(): Promise<void>;
}

/**
 * Read a non-negative number from an env var, accepting only plain decimal
 * spellings (`500`, `0.5`; no exponents, separators or unit suffixes) so a
 * value like `1e6` or `24h` is rejected and logged rather than silently
 * truncated. Returns `fallback` when unset, blank or malformed.
 */
function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, integer: boolean): number {
	const raw = env[name]?.trim();
	if (raw === undefined || raw === '') return fallback;
	const pattern = integer ? /^\d+$/ : /^\d+(\.\d+)?$/;
	if (!pattern.test(raw)) {
		logger.warn({ [name]: raw, fallback }, `Ignoring ${name}: expected a plain non-negative number`);
		return fallback;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Upper bound on held legacy analytics sessions from SESSION_MAX; the least
 * recently active are evicted beyond it. `0` disables the cap.
 */
export function sessionMax(env: NodeJS.ProcessEnv = process.env): number {
	return envNumber(env, 'SESSION_MAX', DEFAULT_SESSION_MAX, true);
}

/**
 * Idle lifetime for legacy analytics sessions from SESSION_IDLE_TTL_HOURS
 * (fractional hours allowed). Defaults to 24h when unset/blank/invalid; `0` disables idle TTL.
 */
export function sessionIdleTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	const hours = envNumber(env, 'SESSION_IDLE_TTL_HOURS', DEFAULT_SESSION_IDLE_TTL_HOURS, false);
	return hours > 0 ? Math.round(hours * 60 * 60 * 1000) : 0;
}

function toRecord(entry: SessionRecord): SessionRecord {
	return {
		id: entry.id,
		connectedAtMs: entry.connectedAtMs,
		lastActivityMs: entry.lastActivityMs,
		requestCount: entry.requestCount,
		isAuthenticated: entry.isAuthenticated,
		...(entry.ipAddress !== undefined ? { ipAddress: entry.ipAddress } : {}),
		...(entry.protocolEra !== undefined ? { protocolEra: entry.protocolEra } : {}),
		...(entry.protocolVersion !== undefined ? { protocolVersion: entry.protocolVersion } : {}),
		...(entry.clientCapabilities !== undefined ? { clientCapabilities: entry.clientCapabilities } : {}),
		...(entry.clientInfo !== undefined ? { clientInfo: entry.clientInfo } : {}),
		...(entry.userHash !== undefined ? { userHash: entry.userHash } : {}),
	};
}

function toSessionMetadata(entry: SessionRecord): SessionMetadata {
	return {
		id: entry.id,
		connectedAt: new Date(entry.connectedAtMs),
		lastActivity: new Date(entry.lastActivityMs),
		requestCount: entry.requestCount,
		isAuthenticated: entry.isAuthenticated,
		capabilities: {},
		ipAddress: entry.ipAddress,
		protocolEra: entry.protocolEra,
		protocolVersion: entry.protocolVersion,
		clientCapabilities: entry.clientCapabilities,
		clientInfo: entry.clientInfo,
		userHash: entry.userHash,
	};
}

/**
 * Authoritative, bounded in-memory registry for legacy analytics sessions.
 * Entries are kept in least-recently-active Map insertion order (`touch` re-inserts).
 */
export class SessionRegistry {
	private readonly sessions = new Map<string, SessionRecord>();
	private readonly metrics: MetricsCounter;
	private readonly idleTtlMs: number;
	private readonly maxSessions: number;
	private sweepTimer?: NodeJS.Timeout;

	constructor(options: SessionRegistryOptions) {
		const env = options.env ?? process.env;
		this.metrics = options.metrics;
		this.idleTtlMs = options.idleTtlMs !== undefined ? options.idleTtlMs : sessionIdleTtlMs(env);
		this.maxSessions = options.maxSessions !== undefined ? options.maxSessions : sessionMax(env);

		if (this.idleTtlMs > 0) {
			logger.info({ sessionIdleTtlMs: this.idleTtlMs }, 'Legacy analytics sessions expire when idle');
		}
	}

	get size(): number {
		return this.sessions.size;
	}

	private isExpired(entry: SessionRecord, now: number): boolean {
		return this.idleTtlMs > 0 && entry.lastActivityMs <= now - this.idleTtlMs;
	}

	private expireSingle(id: string, entry: SessionRecord): void {
		if (!this.sessions.delete(id)) return;
		this.metrics.disconnectClient(entry.clientInfo);
		this.metrics.trackSessionsExpired(1);
		this.metrics.updateActiveConnections(this.sessions.size);
	}

	/**
	 * Non-mutating lookup for early attribution. Expires the entry if past TTL,
	 * but when alive does NOT update lastActivity, requestCount, LRU order, or resumeGaps.
	 */
	peek(id: string, now: number = Date.now()): SessionRecord | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		if (this.isExpired(entry, now)) {
			this.expireSingle(id, entry);
			return undefined;
		}
		return toRecord(entry);
	}

	/**
	 * Atomic resume: if alive, records resumeGap, updates lastActivity & requestCount,
	 * moves entry to the most-recently-active end of the Map, and returns a snapshot.
	 */
	touch(id: string, now: number = Date.now()): SessionRecord | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		if (this.isExpired(entry, now)) {
			this.expireSingle(id, entry);
			return undefined;
		}
		this.metrics.trackSessionResumeGap(Math.max(0, now - entry.lastActivityMs));
		entry.lastActivityMs = now;
		entry.requestCount += 1;
		this.sessions.delete(id);
		this.sessions.set(id, entry);
		return toRecord(entry);
	}

	/**
	 * Store a new session, enforce SESSION_MAX eviction, update active connections,
	 * and synchronously associate the client connection gauge when clientInfo is provided.
	 */
	create(input: CreateSessionInput, now: number = Date.now()): SessionRecord {
		const entry: SessionRecord = {
			id: input.id,
			connectedAtMs: now,
			lastActivityMs: now,
			requestCount: 1,
			isAuthenticated: input.isAuthenticated,
			ipAddress: input.ipAddress,
			protocolEra: input.protocolEra ?? 'legacy',
			protocolVersion: input.protocolVersion,
			clientCapabilities: input.clientCapabilities,
			clientInfo: input.clientInfo,
			userHash: input.userHash,
		};

		const existing = this.sessions.get(input.id);
		if (existing) {
			this.sessions.delete(input.id);
			this.metrics.disconnectClient(existing.clientInfo);
		}

		this.sessions.set(input.id, entry);
		this.metrics.trackSessionCreated();
		if (input.clientInfo) {
			this.metrics.associateSessionWithClient(input.clientInfo);
		}
		this.evictOverCap();
		this.metrics.updateActiveConnections(this.sessions.size);
		logger.debug({ sessionId: input.id, isAuthenticated: input.isAuthenticated }, 'Analytics session created');
		return toRecord(entry);
	}

	/**
	 * Atomically remove a session if present (and not expired), decrementing the
	 * client connection gauge and returning the removed snapshot for delete logging.
	 */
	delete(id: string, now: number = Date.now()): SessionRecord | undefined {
		const entry = this.sessions.get(id);
		if (!entry) return undefined;
		if (this.isExpired(entry, now)) {
			this.expireSingle(id, entry);
			return undefined;
		}
		this.sessions.delete(id);
		this.metrics.trackSessionDeleted();
		this.metrics.disconnectClient(entry.clientInfo);
		this.metrics.updateActiveConnections(this.sessions.size);
		return toRecord(entry);
	}

	/**
	 * Bounded iteration over at most `limit` sessions without copying the entire Map.
	 */
	list(limit = 500): SessionListResult {
		const sessions: SessionMetadata[] = [];
		const cap = Math.max(0, limit);
		for (const entry of this.sessions.values()) {
			if (sessions.length >= cap) break;
			sessions.push(toSessionMetadata(entry));
		}
		return { total: this.sessions.size, sessions };
	}

	private drainSessions(shouldRemove: (entry: SessionRecord) => boolean, limit = Infinity): number {
		let removed = 0;
		for (const [sessionId, entry] of this.sessions) {
			if (removed >= limit || !shouldRemove(entry)) break;
			this.sessions.delete(sessionId);
			this.metrics.disconnectClient(entry.clientInfo);
			removed += 1;
		}
		if (removed > 0) {
			this.metrics.updateActiveConnections(this.sessions.size);
		}
		return removed;
	}

	private evictOverCap(): void {
		if (this.maxSessions <= 0) return;
		const evicted = this.drainSessions(() => this.sessions.size > this.maxSessions);
		if (evicted > 0) {
			this.metrics.trackSessionsEvicted(evicted);
		}
	}

	startSweep(): void {
		if (this.idleTtlMs <= 0 || this.sweepTimer) return;
		const intervalMs = Math.min(
			MAX_SESSION_SWEEP_INTERVAL_MS,
			Math.max(MIN_SESSION_SWEEP_INTERVAL_MS, Math.floor(this.idleTtlMs / 12))
		);
		const sweep = (): void => {
			if (!this.sweepTimer) return;
			if (this.expireIdleSessions() === MAX_SESSIONS_EXPIRED_PER_PASS) {
				setImmediate(sweep);
			}
		};
		this.sweepTimer = setInterval(sweep, intervalMs);
		this.sweepTimer.unref();
	}

	stop(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	expireIdleSessions(now: number = Date.now(), limit: number = MAX_SESSIONS_EXPIRED_PER_PASS): number {
		if (this.idleTtlMs <= 0) return 0;
		const cutoff = now - this.idleTtlMs;
		const expired = this.drainSessions((entry) => entry.lastActivityMs <= cutoff, limit);
		if (expired > 0) {
			this.metrics.trackSessionsExpired(expired);
			logger.info({ expired, remaining: this.sessions.size }, 'Expired idle analytics sessions');
		}
		return expired;
	}

	clearAll(): void {
		this.stop();
		this.drainSessions(() => true);
		this.metrics.updateActiveConnections(0);
	}
}

export class LocalSessionStore implements SessionStore {
	readonly ownsRegistry = true;
	private readonly registry: SessionRegistry;

	constructor(registry: SessionRegistry) {
		this.registry = registry;
	}

	create(input: CreateSessionInput): Promise<SessionRecord> {
		return Promise.resolve(this.registry.create(input));
	}

	peek(id: string): Promise<SessionRecord | undefined> {
		return Promise.resolve(this.registry.peek(id));
	}

	touch(id: string): Promise<SessionRecord | undefined> {
		return Promise.resolve(this.registry.touch(id));
	}

	delete(id: string): Promise<SessionRecord | undefined> {
		return Promise.resolve(this.registry.delete(id));
	}

	getLocalCount(): number {
		return this.registry.size;
	}

	getLocalSessions(limit = 500): SessionMetadata[] {
		return this.registry.list(limit).sessions;
	}

	getLocalSessionList(limit = 500): SessionListResult {
		return this.registry.list(limit);
	}

	startSweep(): void {
		this.registry.startSweep();
	}

	cleanup(): Promise<void> {
		this.registry.clearAll();
		return Promise.resolve();
	}
}

export class ClusterSessionStore implements SessionStore {
	readonly ownsRegistry = false;
	private readonly remoteCreate: (input: CreateSessionInput) => Promise<SessionRecord>;
	private readonly remotePeek: (id: string) => Promise<SessionRecord | undefined>;
	private readonly remoteTouch: (id: string) => Promise<SessionRecord | undefined>;
	private readonly remoteDelete: (id: string) => Promise<SessionRecord | undefined>;

	constructor(primaryRegistry?: SessionRegistry, timeoutMs = 1_000) {
		const requireRegistry = (): SessionRegistry => {
			if (!primaryRegistry) {
				throw new Error('Primary SessionRegistry is not registered');
			}
			return primaryRegistry;
		};
		this.remoteCreate = remote(
			'session.create',
			(input: CreateSessionInput) => requireRegistry().create(input),
			timeoutMs
		);
		this.remotePeek = remote('session.peek', (id: string) => requireRegistry().peek(id), timeoutMs);
		this.remoteTouch = remote('session.touch', (id: string) => requireRegistry().touch(id), timeoutMs);
		this.remoteDelete = remote('session.delete', (id: string) => requireRegistry().delete(id), timeoutMs);
	}

	create(input: CreateSessionInput): Promise<SessionRecord> {
		return this.remoteCreate(input);
	}

	peek(id: string): Promise<SessionRecord | undefined> {
		return this.remotePeek(id);
	}

	touch(id: string): Promise<SessionRecord | undefined> {
		return this.remoteTouch(id);
	}

	delete(id: string): Promise<SessionRecord | undefined> {
		return this.remoteDelete(id);
	}

	getLocalCount(): number {
		return 0;
	}

	getLocalSessions(): SessionMetadata[] {
		return [];
	}

	getLocalSessionList(): SessionListResult {
		return { total: 0, sessions: [] };
	}

	startSweep(): void {
		// Primary owns the sweep timer
	}

	cleanup(): Promise<void> {
		// Workers must never clear or disconnect primary's shared sessions
		return Promise.resolve();
	}
}

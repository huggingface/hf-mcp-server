import type { PtcAccess } from '@llmindset/hf-mcp';
import type { HfWhoamiResponse } from '../utils/hf-whoami-client.js';

/**
 * Listing policy: every tool the token can use is listed; clients search them.
 * - no token                         -> anonymous
 * - token the server could not verify -> authenticated (read tools only)
 * - token reported as read-only       -> authenticated
 * - any other verified token          -> write (Hub still enforces per call)
 */
export function ptcAccess(hfToken: string | undefined, user: HfWhoamiResponse | undefined): PtcAccess {
	if (!hfToken) return 'anonymous';
	if (!user) return 'authenticated';
	return user.auth.accessToken?.role === 'read' ? 'authenticated' : 'write';
}

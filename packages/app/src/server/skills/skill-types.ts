/** YAML frontmatter of a `SKILL.md`, represented as JSON by SEP-2640. */
export interface SkillFrontmatter {
	name: string;
	description: string;
	[key: string]: unknown;
}

/** One file in a static skill's content-bound resource manifest. */
export interface SkillManifestResource {
	uri: string;
	digest: string;
}

/** Protocol-facing shape returned by `skills/list` and `skills/get`. */
export interface SkillProtocolEntry {
	uri: string;
	frontmatter: SkillFrontmatter;
	resources: SkillManifestResource[];
}

/** Internal entry data retained with the protocol-facing fields. */
export interface SkillEntry extends SkillProtocolEntry {
	/** Decoded `<skill-path>` from the URI, e.g. `acme/billing/refunds`. */
	skillPath: string;
}

/** A verified file retained entirely in an immutable in-memory snapshot. */
export interface ReadableSkillFile {
	uri: string;
	bytes: Buffer;
	mimeType: string;
	isText: boolean;
	name: string;
	description?: string;
	digest: string;
}

/** A direct child of a directory resource, returned by `resources/directory/read`. */
export interface SkillDirChild {
	uri: string;
	name: string;
	mimeType: string;
}

/** One fully validated, immutable point-in-time view of the published skills. */
export interface SkillCatalog {
	manifestPath: string;
	loadedAt: number;
	entries: SkillEntry[];
	entriesByUri: Map<string, SkillEntry>;
	resourcesByUri: Map<string, ReadableSkillFile>;
	/** Directory URI (no trailing slash) → its direct children. */
	directories: Map<string, SkillDirChild[]>;
}

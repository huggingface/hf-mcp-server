// Types for the experimental Skills extension (SEP-2640).
//
// The index format follows the Skills Over MCP Working Group decision of 2026-06-05:
// each `skill://index.json` entry carries a verbatim `frontmatter` object, an optional
// `url` + `digest` (for individually-addressable skills), and a per-skill `archives[]`
// array. There is no top-level `name`/`type`/`description`/`$schema`.

/** YAML frontmatter of a `SKILL.md`, rendered verbatim as JSON in the index. */
export interface SkillFrontmatter {
	name: string;
	description: string;
	[key: string]: unknown;
}

/** A single readable file resource served over MCP (`resources/read`). */
export interface ReadableSkillFile {
	url: string;
	absPath: string;
	mimeType: string;
	isText: boolean;
}

/** A file within a skill directory, individually addressable as a resource. */
export interface SkillResource extends ReadableSkillFile {
	/** Resource name: the skill `name` for `SKILL.md`, otherwise the file basename. */
	name: string;
	/** Only the `SKILL.md` resource carries a description (from frontmatter). */
	description?: string;
}

/** A pre-packed archive form of an entire skill directory. */
export interface SkillArchive extends ReadableSkillFile {
	name: string;
	digest?: string;
}

/** A direct child of a directory resource, returned by `resources/directory/read`. */
export interface SkillDirChild {
	uri: string;
	name: string;
	mimeType: string;
}

/** One skill: its frontmatter, addressable files (if any), and archive forms (if any). */
export interface SkillEntry {
	/** `<skill-path>` from the URI, e.g. `git-workflow` or `acme/billing/refunds`. */
	skillPath: string;
	frontmatter: SkillFrontmatter;
	/** Present when the skill is individually addressable (has a `url`). */
	skillMd?: { url: string; digest?: string };
	/** All files under the skill directory (includes `SKILL.md`); empty for archive-only skills. */
	files: SkillResource[];
	archives: SkillArchive[];
}

export interface SkillCatalog {
	indexPath: string;
	indexText: string;
	entries: SkillEntry[];
	/** Flattened lookup of every readable file (skill files + archives) by URI. */
	resourcesByUri: Map<string, ReadableSkillFile>;
	/** Directory URI (no trailing slash) → its direct children, for `resources/directory/read`. */
	directories: Map<string, SkillDirChild[]>;
}

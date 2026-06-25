import { logger } from '../utils/logger.js';
import { loadSkills } from './skill-loader.js';
import type { SkillCatalog } from './skill-types.js';

// Experimental Skills extension (SEP-2640).
// In the deployed Hugging Face Space, mount hf://buckets/huggingface/skills at /mnt/hf-skills.
// Override via HF_SKILLS_DIR for local tests or alternate layouts.
const SKILLS_DIR = process.env.HF_SKILLS_DIR ?? '/mnt/hf-skills/distribution/latest';

let skillCatalogPromise: Promise<SkillCatalog | null> | null = null;

export function getSkillCatalog(): Promise<SkillCatalog | null> {
	if (!skillCatalogPromise) {
		skillCatalogPromise = loadSkills(SKILLS_DIR).catch((err) => {
			logger.warn({ err, SKILLS_DIR }, 'failed to load skills, skills disabled');
			return null;
		});
	}
	return skillCatalogPromise;
}

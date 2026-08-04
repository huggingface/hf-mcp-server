import { z } from 'zod';

export const SKILLS_LIST_METHOD = 'skills/list';
export const SKILLS_GET_METHOD = 'skills/get';

export const SkillsListParamsSchema = z.looseObject({
	cursor: z.string().optional(),
});

export const SkillsGetParamsSchema = z.looseObject({
	uri: z.string(),
});

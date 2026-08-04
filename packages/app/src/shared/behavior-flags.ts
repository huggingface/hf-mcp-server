export const README_INCLUDE_FLAG = 'ALLOW_README_INCLUDE' as const;
export const GRADIO_IMAGE_FILTER_FLAG = 'NO_GRADIO_IMAGE_CONTENT' as const;

export interface ToolBehaviorFlags {
	allowReadmeInclude: boolean;
	stripGradioImages: boolean;
	enableHfFsWrite: boolean;
}

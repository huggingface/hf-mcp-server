// Curated reader-facing examples, not an exhaustive list of server switches.
// Keep this browser-only: bouquet-presets imports the server's MCP tool package.
export const MCP_URL_BASE = 'https://huggingface.co/mcp?login';

export const MCP_URL_OPTIONS = [
	{
		title: 'Choose a tool preset',
		query: 'bouquet=files',
		description: 'Replace your saved built-in tool selection with a focused preset.',
		note: 'Presets other than “all” also leave out saved Gradio Spaces unless you supply gradio.',
	},
	{
		title: 'Add to your existing tools',
		query: 'mix=jobs,sandbox',
		description: 'Add presets to your saved tools, or the defaults if you have no saved selection.',
		note: 'Separate presets with commas. Use mix without bouquet; bouquet takes precedence.',
	},
	{
		title: 'Connect a Gradio Space',
		query: 'gradio=victor/websearch',
		description: 'Add tools from an MCP-enabled Space using its owner/space-name.',
		note: 'Separate multiple Spaces with commas. Use gradio=none to leave out all connected Gradio Spaces.',
	},
	{
		title: 'Keep image results out',
		query: 'no_image_content=true',
		description: 'Remove image content blocks returned by connected Gradio tools.',
		note: 'Useful for text-only clients or when you do not need image results.',
	},
] as const;

export const MCP_URL_PRESETS = [
	{
		key: 'files',
		description: 'Search the Hub and read files, papers and documentation. Read-only: no Hub file writes.',
	},
	{ key: 'jobs', description: 'Run and manage Hugging Face Jobs.' },
	{ key: 'sandbox', description: 'Run code and work with files inside a compute sandbox.' },
	{
		key: 'intern',
		description:
			'End-to-end workflows: read/write Hub files, create repositories, run code in sandboxes, and manage Jobs.',
	},
] as const;

export const FILE_ICON_BY_EXTENSION: Readonly<Record<string, string>> = {
	py: '🐍',
	js: '📜',
	ts: '📘',
	md: '📝',
	txt: '📄',
	json: '📊',
	yaml: '⚙️',
	yml: '⚙️',
	png: '🖼️',
	jpg: '🖼️',
	jpeg: '🖼️',
	gif: '🖼️',
	svg: '🎨',
	mp4: '🎬',
	mp3: '🎵',
	pdf: '📕',
	zip: '📦',
	tar: '📦',
	gz: '📦',
	html: '🌐',
	css: '🎨',
	ipynb: '📓',
	csv: '📊',
	parquet: '🗄️',
	safetensors: '🤖',
	bin: '💾',
	pkl: '🥒',
	h5: '🗃️',
};

export function getFileIcon(filename: string): string {
	const extension = filename.split('.').pop()?.toLowerCase();
	if (!extension) {
		return '📄';
	}

	return FILE_ICON_BY_EXTENSION[extension] ?? '📄';
}

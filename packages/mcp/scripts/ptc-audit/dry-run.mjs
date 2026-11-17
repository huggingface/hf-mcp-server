/**
 * Offline chaining check ("dry run"). For every consumer argument, feed each value form that a
 * producer emits (built with the same helpers the tools use) through callPtcTool with the network
 * disabled. A call that reaches the network with the identifier in the request URL accepted the
 * value verbatim; INVALID_ARGUMENT before any request means the link is broken.
 *
 * Safe for write tools: fetch is replaced for the whole process, nothing leaves the machine.
 */
import { CONSUMERS, effectiveTypes } from './rules.mjs';

const JOB = '68f0c0ffee0123456789abcd';

/** Value forms per resource type. `needle` must appear in a request URL (encoded or not). */
export function sampleValues(refs) {
	const { repoItem, fileItem, paperItem, collectionItem, docItem } = refs;
	const repo = (kind) => {
		const r = repoItem(kind, 'acme/thing');
		return [
			{ form: 'id', value: r.id, needle: 'acme/thing' },
			{ form: 'uri', value: r.uri, needle: 'acme/thing' },
			{ form: 'url', value: r.url, needle: 'acme/thing' },
		];
	};
	const file = fileItem('model', 'acme/thing', 'docs/README.md', 'file');
	const fileRev = fileItem('model', 'acme/thing', 'docs/README.md', 'file', 'refs/pr/3');
	const dir = fileItem('model', 'acme/thing', 'docs', 'dir');
	const paper = paperItem('2405.02730');
	const coll = collectionItem('acme/my-papers-6650a1b2c3d4e5f6a7b8c9d0');
	const doc = docItem('transformers/quicktour', 'https://huggingface.co/docs/transformers/quicktour');
	const person = (name) => [
		{ form: 'id', value: name, needle: name },
		{ form: 'uri (profile url)', value: `https://huggingface.co/${name}`, needle: name },
		{ form: 'url (profile url)', value: `https://huggingface.co/${name}`, needle: name },
	];
	return {
		'repo:model': [...repo('model'), { form: 'uri (legacy unnamespaced)', value: 'hf://models/gpt2', needle: 'gpt2' }],
		'repo:dataset': repo('dataset'),
		'repo:space': repo('space'),
		'repo:bucket': repo('bucket'),
		file: [
			{ form: 'uri', value: file.uri, needle: 'README.md' },
			{ form: 'url', value: file.url, needle: 'README.md' },
			{ form: 'uri@revision', value: fileRev.uri, needle: 'README.md' },
			{ form: 'id (path only)', value: file.id, needle: 'README.md' },
		],
		'file->repo': [
			{ form: 'uri', value: file.uri, needle: 'acme/thing' },
			{ form: 'url', value: file.url, needle: 'acme/thing' },
		],
		dir: [
			{ form: 'uri', value: dir.uri, needle: 'docs' },
			{ form: 'url', value: dir.url, needle: 'docs' },
			{ form: 'id (path only)', value: dir.id, needle: 'docs' },
		],
		paper: [
			{ form: 'id', value: paper.id, needle: '2405.02730' },
			{ form: 'uri', value: paper.uri, needle: '2405.02730' },
			{ form: 'url', value: paper.url, needle: '2405.02730' },
			{ form: 'tag arxiv:ID (repo tags)', value: 'arxiv:2405.02730', needle: '2405.02730' },
		],
		collection: [
			{ form: 'id', value: coll.id, needle: 'my-papers' },
			{ form: 'uri', value: coll.uri, needle: 'my-papers' },
			{ form: 'url', value: coll.url, needle: 'my-papers' },
		],
		doc: [
			{ form: 'id', value: doc.id, needle: 'quicktour' },
			{ form: 'uri', value: doc.uri, needle: 'quicktour' },
			{ form: 'uri#anchor', value: `${doc.uri}#installation`, needle: 'quicktour' },
			{ form: 'url', value: doc.url, needle: 'quicktour' },
		],
		user: person('acme'),
		org: person('acme-org'),
		discussion: [
			{ form: 'uri (web url)', value: 'https://huggingface.co/acme/thing/discussions/3', needle: 'acme/thing' },
			{ form: 'url (web url)', value: 'https://huggingface.co/acme/thing/discussions/3', needle: 'acme/thing' },
			{ form: 'id (owner/name#num)', value: 'acme/thing#3', needle: 'acme/thing' },
		],
		discussion_num: [{ form: 'num', value: 3 }],
		job: [
			{ form: 'id', value: JOB, needle: JOB },
			{ form: 'url', value: `https://huggingface.co/jobs/acme/${JOB}`, needle: JOB },
		],
		scheduled_job: [{ form: 'id', value: JOB, needle: JOB }],
		job_kind: [
			{ form: 'kind=job', value: 'job' },
			{ form: 'kind=scheduled_job', value: 'scheduled_job' },
		],
		sandbox: [
			{ form: 'id (handle)', value: `hfsb2:acme:${JOB}`, needle: JOB },
			{ form: 'namespace/job_id', value: `acme/${JOB}`, needle: JOB },
			{ form: 'url (job page)', value: `https://huggingface.co/jobs/acme/${JOB}`, needle: JOB },
		],
		process: [{ form: 'id', value: 'proc-1' }],
		process_tag: [{ form: 'tag', value: 'train' }],
		sandbox_path: [
			{ form: 'path', value: '/tmp/out' },
			{ form: 'id (absolute path)', value: '/tmp/out/a.txt' },
		],
		revision: [
			{ form: 'sha', value: 'a'.repeat(40) },
			{ form: 'id (commit sha)', value: 'b'.repeat(40) },
			{ form: 'git ref (refs/pr/N)', value: 'refs/pr/3' },
			{ form: 'branch', value: 'main' },
		],
		dataset_config: [{ form: 'name', value: 'default' }],
		dataset_split: [{ form: 'name', value: 'train' }],
		flavor: [{ form: 'name', value: 'a10g-small' }],
		space_tool: [{ form: 'name', value: 'predict' }],
		tag: [
			{ form: 'tag', value: 'license:mit' },
			{ form: 'tag', value: 'text-generation' },
		],
		task: [{ form: 'name', value: 'text-generation' }],
		library: [{ form: 'name', value: 'transformers' }],
		license: [{ form: 'name', value: 'apache-2.0' }],
		language: [{ form: 'name', value: 'en' }],
		sdk: [{ form: 'name', value: 'gradio' }],
		provider: [{ form: 'name', value: 'together' }],
		http_file: [{ form: 'https url', value: 'https://huggingface.co/datasets/acme/thing/resolve/main/train.py' }],
	};
}

/** Wrong-kind probes for kind-specific repository arguments: should be rejected, not silently used. */
const WRONG_KIND = {
	'repo:model': 'hf://datasets/acme/other',
	'repo:dataset': 'hf://models/acme/other',
	'repo:space': 'hf://models/acme/other',
	'repo:bucket': 'hf://models/acme/other',
};

function installFetchStub() {
	const calls = [];
	const original = globalThis.fetch;
	const stub = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		calls.push({
			url,
			method: init?.method ?? 'GET',
			body:
				typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '',
		});
		if (/\/api\/whoami-v2/.test(url))
			return new Response(
				JSON.stringify({
					name: 'acme',
					type: 'user',
					orgs: [{ name: 'acme-org' }],
					auth: { accessToken: { role: 'write' } },
				}),
				{
					status: 200,
					headers: { 'content-type': 'application/json' },
				}
			);
		throw new TypeError('ptc-audit: network disabled');
	};
	globalThis.fetch = stub;
	return { calls, stub, restore: () => (globalThis.fetch = original) };
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

async function probe(ptc, consumer, value, needle) {
	const tool = ptc.getPtcTool(consumer.tool);
	const args = { ...(consumer.extra ?? {}), [consumer.arg]: consumer.array ? [value] : value };
	if (consumer.tool === 'hf_job_run' && consumer.arg === 'script') delete args.command;
	const net = installFetchStub();
	const ctx = {
		hfToken: 'hf_auditdummytoken0000000000000000',
		username: 'acme',
		fetch: net.stub,
		signal: AbortSignal.timeout(8000),
	};
	let status;
	let detail = '';
	try {
		await ptc.callPtcTool(tool, args, ctx);
		status = net.calls.length ? 'accepted' : 'no_request';
	} catch (error) {
		const code = error?.code ?? 'ERROR';
		const message = String(error?.message ?? error).slice(0, 220);
		if (net.calls.length) status = 'accepted';
		else if (code === 'INVALID_ARGUMENT') {
			status = 'rejected';
			detail = message;
		} else {
			status = `error:${code}`;
			detail = message;
		}
	} finally {
		net.restore();
	}
	const calls = net.calls.filter((c) => !/whoami/.test(c.url));
	const urls = calls.map((c) => c.url);
	if (status === 'accepted' && needle) {
		const seen = (u) => u.includes(needle) || safeDecode(u).includes(needle) || u.includes(encodeURIComponent(needle));
		const inBody = (b) => Boolean(b) && needle.split('/').every((part) => b.includes(part));
		const hit = calls.some((c) => seen(c.url) || inBody(c.body));
		if (!hit && urls.length) status = 'unverified';
		if (!urls.length) status = 'accepted';
	}
	return { status, detail, urls: urls.slice(0, 3) };
}

export async function runDryRun(ptc, refs, { consumers = CONSUMERS } = {}) {
	const samples = sampleValues(refs);
	const results = [];
	for (const consumer of consumers) {
		if (!ptc.getPtcTool(consumer.tool)) continue;
		const key = `${consumer.tool}.${consumer.label ?? consumer.arg}`;
		for (const type of effectiveTypes(consumer)) {
			for (const original of samples[type] ?? []) {
				// image readers get an image path; everything else the README sample
				const swap = (v) => (consumer.image && typeof v === 'string' ? v.replace('README.md', 'chart.png') : v);
				const sample = { ...original, value: swap(original.value), needle: swap(original.needle) };
				const value = sample.value;
				const r = await probe(ptc, consumer, value, sample.needle);
				results.push({ consumer: key, type, form: sample.form, value: sample.value, ...r });
				if (consumer.mount && typeof sample.value === 'string') {
					const mounted = await probe(ptc, consumer, `${sample.value}:/data`, sample.needle);
					results.push({
						consumer: key,
						type,
						form: `${sample.form} + ":/data"`,
						value: `${sample.value}:/data`,
						...mounted,
					});
				}
			}
		}
		// wrong-kind probe
		const kinds = consumer.types.filter((t) => t.startsWith('repo:'));
		if (kinds.length === 1 && !consumer.mount) {
			const r = await probe(ptc, consumer, WRONG_KIND[kinds[0]], 'acme/other');
			results.push({
				consumer: key,
				type: `wrong-kind for ${kinds[0]}`,
				form: 'uri',
				value: WRONG_KIND[kinds[0]],
				negative: true,
				...r,
			});
		}
	}
	return results;
}

/** Alias probe: habitual argument names a model may use instead of the canonical one. */
export const HABITUAL = {
	repository: ['repo_id', 'repo', 'id', 'uri', 'url', 'ref', 'model_id', 'dataset_id', 'space_id'],
	person: ['handle', 'username', 'user', 'org', 'owner', 'author', 'entity', 'namespace'],
	paper: ['paper_id', 'arxiv_id', 'id', 'uri'],
	collection: ['collection_id', 'slug', 'uri', 'id'],
	job: ['job_id', 'id', 'job'],
	sandbox: ['sandbox_id', 'id', 'handle', 'sandbox'],
	file: ['uri', 'url', 'ref', 'path', 'file', 'file_uri'],
	doc: ['uri', 'url', 'page', 'path'],
};

function habitualGroup(consumer) {
	const t = consumer.types;
	if (t.some((x) => x.startsWith('repo:'))) return 'repository';
	if (t.includes('user') || t.includes('org')) return 'person';
	if (t.includes('paper')) return 'paper';
	if (t.includes('collection')) return 'collection';
	if (t.includes('job')) return t.includes('sandbox') ? 'sandbox' : 'job';
	if (t.includes('sandbox')) return 'sandbox';
	if (t.includes('file')) return 'file';
	if (t.includes('doc')) return 'doc';
	return undefined;
}

export function runAliasProbe(ptc, refs, { consumers = CONSUMERS } = {}) {
	const samples = sampleValues(refs);
	const out = [];
	const seen = new Set();
	for (const consumer of consumers) {
		const tool = ptc.getPtcTool(consumer.tool);
		if (!tool) continue;
		const group = habitualGroup(consumer);
		if (!group || seen.has(`${consumer.tool}.${consumer.arg}`)) continue;
		seen.add(`${consumer.tool}.${consumer.arg}`);
		const sample =
			(samples[consumer.types[0]] ?? []).find(
				(s) => s.form.startsWith('uri') || s.form === 'id' || s.form === 'id (handle)'
			) ?? samples[consumer.types[0]]?.[0];
		if (!sample) continue;
		const accepted = [];
		const refused = [];
		for (const alias of HABITUAL[group]) {
			if (alias === consumer.arg) continue;
			const shape = tool.input.shape;
			if (alias in shape) continue; // the tool has its own argument of that name
			const args = { ...(consumer.extra ?? {}), [alias]: sample.value };
			const normalized = ptc.normalizePtcArguments(tool.input, args);
			const parsed = tool.input.safeParse(normalized);
			const mapped = parsed.success && normalized?.[consumer.arg] !== undefined;
			(mapped ? accepted : refused).push(alias);
		}
		out.push({ consumer: `${consumer.tool}.${consumer.arg}`, group, accepted, refused });
	}
	return out;
}

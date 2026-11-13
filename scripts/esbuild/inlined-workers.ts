// Adapted from https://github.com/mitschabaude/esbuild-plugin-inline-worker

import * as esbuild from 'esbuild';

export function inlineWorkerPlugin(extraConfig: esbuild.BuildOptions): esbuild.Plugin {
	return {
		name: 'esbuild-plugin-inline-worker',

		setup(build) {
			build.onLoad(
				{ filter: /\.worker\.(js|jsx|ts|tsx)$/ },
				async ({ path: workerPath }) => {
					const workerCode = await buildWorker(workerPath, extraConfig);
					return {
						contents: `import inlineWorker from '__inline-worker'
const cache = {};
export default function Worker() {
  return inlineWorker(${JSON.stringify(workerCode)}, cache);
}
`,
						loader: 'js',
					};
				},
			);

			const inlineWorkerFunctionCode = `
export default async function inlineWorker(scriptText, cache) {
	if (typeof Worker !== 'undefined' && typeof Bun === 'undefined') {
		// Browser, Deno (Deno can't do dynamic import of worker_threads)

		// Reused instead of revoked, since Deno fails when the URL is revoked right after creating the worker
		if (!cache.url) {
			const blob = new Blob([scriptText], { type: "text/javascript" });
			cache.url = URL.createObjectURL(blob);
		}
		const worker = new Worker(cache.url, {
			type: typeof Deno !== 'undefined' ? 'module' : undefined, // module for Deno
		});
		return worker;
	} else {
		// Node, Bun (Bun's Worker is flaky, worker_threads works much better)

		let Worker;
		try {
			Worker = (await import('worker_threads')).Worker;
		} catch {
			Worker = require('worker_threads').Worker;
		}
		
		const worker = new Worker(scriptText, { eval: true });
		
		return worker;
	}
}
`;

			build.onResolve({ filter: /^__inline-worker$/ }, ({ path }) => {
				return { path, namespace: 'inline-worker' };
			});
			build.onResolve({ filter: /^worker_threads$/ }, ({ path }) => {
				return { path, external: true }; // Keep it in the bundle
			});
			build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, () => {
				return { contents: inlineWorkerFunctionCode, loader: 'js' };
			});
		},
	};
}

async function buildWorker(workerPath: string, extraConfig: esbuild.BuildOptions) {
	if (extraConfig) {
		delete extraConfig.entryPoints;
		delete extraConfig.outfile;
		delete extraConfig.outdir;
	}

	const result = await esbuild.build({
		entryPoints: [workerPath],
		bundle: true,
		minify: true,
		target: 'es2017',
		format: 'esm',
		...extraConfig,
		write: false, // In memory
	});

	return result.outputFiles[0]!.text;
}

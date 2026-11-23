// Adapted from https://github.com/mitschabaude/esbuild-plugin-inline-worker

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

export const inlineWorkerPlugin = (
	workerUrlSymbolName: string,
	extraConfig: esbuild.BuildOptions,
): esbuild.Plugin => {
	return {
		name: 'esbuild-plugin-inline-worker',

		setup(build) {
			build.onLoad(
				{ filter: /\.worker\.(js|jsx|ts|tsx)$/ },
				async ({ path: workerPath }) => {
					const workerCode = await buildWorker(workerPath, extraConfig);

					// Also ship the worker as a standalone file, for environments that can't run blob: workers
					const outfile = build.initialOptions.outfile;
					if (!outfile) {
						throw new Error('Inlined workers require the outfile option.');
					}
					const bundleBase = outfile.replace(/(\.min)?\.(js|mjs|cjs)$/, '');
					fs.mkdirSync(path.dirname(outfile), { recursive: true });
					fs.writeFileSync(`${bundleBase}.worker.js`, workerCode);

					return {
						contents: `import inlineWorker from '__inline-worker'
const cache = {};
export default () => inlineWorker(${JSON.stringify(workerCode)}, cache, ${JSON.stringify(workerUrlSymbolName)});
`,
						loader: 'js',
					};
				},
			);

			const inlineWorkerFunctionCode = `
const inlineWorker = async (scriptText, cache, workerUrlSymbolName) => {
	const workerUrl = globalThis[Symbol.for(workerUrlSymbolName)];
	if (workerUrl !== undefined && typeof workerUrl !== 'string' && !(workerUrl instanceof URL)) {
		throw new TypeError(
			"globalThis[Symbol.for('" + workerUrlSymbolName + "')], when provided, must be a string or URL.",
		);
	}

	if (typeof Worker !== 'undefined' && typeof Bun === 'undefined') {
		// Browser, Deno (Deno can't do dynamic import of worker_threads)

		const options = {
			type: typeof Deno !== 'undefined' ? 'module' : undefined, // module for Deno
		};

		if (workerUrl !== undefined) {
			return new Worker(workerUrl, options);
		}

		// Reused instead of revoked, since Deno fails when the URL is revoked right after creating the worker
		if (!cache.url) {
			const blob = new Blob([scriptText], { type: "text/javascript" });
			cache.url = URL.createObjectURL(blob);
		}
		const worker = new Worker(cache.url, options);
		return worker;
	} else {
		// Node, Bun (Bun's Worker is flaky, worker_threads works much better)

		let Worker;
		try {
			Worker = (await import('worker_threads')).Worker;
		} catch {
			Worker = require('worker_threads').Worker;
		}

		if (workerUrl !== undefined) {
			return new Worker(workerUrl);
		}

		const worker = new Worker(scriptText, { eval: true });

		return worker;
	}
};

export default inlineWorker;
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
};

const buildWorker = async (workerPath: string, extraConfig: esbuild.BuildOptions) => {
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
};

// Adapted from https://github.com/mitschabaude/esbuild-plugin-inline-worker

import * as esbuild from 'esbuild';
import findCacheDir from 'find-cache-dir';
import fs from 'node:fs';
import path from 'node:path';

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
export default function Worker() {
  return inlineWorker(${JSON.stringify(workerCode)});
}
`,
						loader: 'js',
					};
				},
			);

			const inlineWorkerFunctionCode = `
export default async function inlineWorker(scriptText) {
	if (typeof Worker !== 'undefined' && typeof Bun === 'undefined') {
		// Browser, Deno (Deno can't do dynamic import of worker_threads)

		const blob = new Blob([scriptText], { type: "text/javascript" });
		const url = URL.createObjectURL(blob);
		const worker = new Worker(url, { type: typeof Deno !== 'undefined' ? 'module' : undefined }); // module for Deno
		URL.revokeObjectURL(url);
		return worker;
	} else {
		// Node, Bun (Bun's Worker is flaky, worker_threads works much better)

		let Worker;
		const workerModule = 'node:worker_threads';
		try {
			Worker = (await import(workerModule)).Worker;
		} catch {
			Worker = require(workerModule).Worker;
		}
		
		const worker = new Worker(scriptText, { eval: true });
		
		return worker;
	}
}
`;

			build.onResolve({ filter: /^__inline-worker$/ }, ({ path }) => {
				return { path, namespace: 'inline-worker' };
			});
			build.onLoad({ filter: /.*/, namespace: 'inline-worker' }, () => {
				return { contents: inlineWorkerFunctionCode, loader: 'js' };
			});
		},
	};
}

const cacheDir = findCacheDir({
	name: 'esbuild-plugin-inline-worker',
	create: true,
});
if (cacheDir === undefined) {
	throw new Error('Cache directory not found.');
}

let i = 0;

async function buildWorker(workerPath: string, extraConfig: esbuild.BuildOptions) {
	const scriptNameParts = path.basename(workerPath).split('.');
	scriptNameParts.pop();
	scriptNameParts.push(String(i)); // To make sure it doesn't clash with other builds
	scriptNameParts.push('js');
	const scriptName = scriptNameParts.join('.');
	const bundlePath = path.resolve(cacheDir!, scriptName);

	i = (i + 1) % 32;

	if (extraConfig) {
		delete extraConfig.entryPoints;
		delete extraConfig.outfile;
		delete extraConfig.outdir;
	}

	await esbuild.build({
		entryPoints: [workerPath],
		bundle: true,
		minify: true,
		outfile: bundlePath,
		target: 'es2017',
		format: 'esm',
		...extraConfig,
	});

	return fs.promises.readFile(bundlePath, { encoding: 'utf-8' });
}

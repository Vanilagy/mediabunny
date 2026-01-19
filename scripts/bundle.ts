import * as esbuild from 'esbuild';
import process from 'node:process';
import PluginExternalGlobal from 'esbuild-plugin-external-global';
import { inlineWorkerPlugin } from './esbuild/inlined-workers.js';

/** Creates UMD and ESM variants, each unminified and minified. */
const createVariants = async (
	entryPoint: string,
	globalName: string,
	outfileBase: string,
	umdExtension: string,
	specificUmdConfig: esbuild.BuildOptions = {},
	specificEsmConfig: esbuild.BuildOptions = {},
) => {
	const baseConfig: esbuild.BuildOptions = {
		entryPoints: [entryPoint],
		bundle: true,
		logLevel: 'info',
		logOverride: {
			'import-is-undefined': 'silent', // Warning caused by the disabled "node.ts" import
		},
		banner: {
			js: `/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */`,
		},
		legalComments: 'none',
	};

	const umdConfig: esbuild.BuildOptions = {
		...baseConfig,
		format: 'iife',
		globalName,
		footer: {
			js:
`if (typeof module === "object" && typeof module.exports === "object") Object.assign(module.exports, ${globalName})`,
		},
	};

	const esmConfig: esbuild.BuildOptions = {
		...baseConfig,
		format: 'esm',
	};

	const umdVariant = await esbuild.context({
		...umdConfig,
		...specificUmdConfig,
		outfile: `${outfileBase}.${umdExtension}`,
	});

	const esmVariant = await esbuild.context({
		...esmConfig,
		...specificEsmConfig,
		outfile: `${outfileBase}.mjs`,
	});

	const umdMinifiedVariant = await esbuild.context({
		...umdConfig,
		...specificUmdConfig,
		outfile: `${outfileBase}.min.${umdExtension}`,
		minify: true,
	});

	const esmMinifiedVariant = await esbuild.context({
		...esmConfig,
		...specificEsmConfig,
		outfile: `${outfileBase}.min.mjs`,
		minify: true,
	});

	return [umdVariant, esmVariant, umdMinifiedVariant, esmMinifiedVariant];
};

const mediabunnyVariants = await createVariants(
	'src/index.ts',
	'Mediabunny',
	'dist/bundles/mediabunny',
	'cjs',
);

const mp3EncoderVariants = await createVariants(
	'packages/mp3-encoder/src/index.ts',
	'MediabunnyMp3Encoder',
	'packages/mp3-encoder/dist/bundles/mediabunny-mp3-encoder',
	'js', // The bundles are purely for the browser, not for Node (due to the peer dependecy)
	{
		plugins: [
			PluginExternalGlobal.externalGlobalPlugin({
				mediabunny: 'Mediabunny',
			}),
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
	{
		external: ['mediabunny'],
		plugins: [
			inlineWorkerPlugin({
				define: {
					'import.meta.url': '""',
				},
				legalComments: 'none',
			}),
		],
	},
);

const contexts = [
	...mediabunnyVariants,
	...mp3EncoderVariants,
];

if (process.argv[2] === '--watch') {
	await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
	for (const ctx of contexts) {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

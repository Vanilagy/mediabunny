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
	nodeUmdVariant = false,
) => {
	const baseConfig: esbuild.BuildOptions = {
		entryPoints: [entryPoint],
		bundle: true,
		logLevel: 'info',
		target: 'es2021',
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

	const variants = [umdVariant, esmVariant, umdMinifiedVariant, esmMinifiedVariant];

	if (nodeUmdVariant) {
		const nodeVariant = await esbuild.context({
			...umdConfig,
			...specificUmdConfig,
			outfile: `${outfileBase}.node.${umdExtension}`,
			platform: 'node', // This is different
		});
		variants.push(nodeVariant);
	}

	return variants;
};

const mediabunnyVariants = await createVariants(
	'src/index.ts',
	'Mediabunny',
	'dist/bundles/mediabunny',
	'cjs',
	undefined,
	undefined,
	true,
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

const ac3Variants = await createVariants(
	'packages/ac3/src/index.ts',
	'MediabunnyAc3',
	'packages/ac3/dist/bundles/mediabunny-ac3',
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

const aacEncoderVariants = await createVariants(
	'packages/aac-encoder/src/index.ts',
	'MediabunnyAacEncoder',
	'packages/aac-encoder/dist/bundles/mediabunny-aac-encoder',
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

const flacEncoderVariants = await createVariants(
	'packages/flac-encoder/src/index.ts',
	'MediabunnyFlacEncoder',
	'packages/flac-encoder/dist/bundles/mediabunny-flac-encoder',
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
	...ac3Variants,
	...aacEncoderVariants,
	...flacEncoderVariants,
];

if (process.argv[2] === '--watch') {
	await Promise.all(contexts.map(ctx => ctx.watch()));
} else {
	for (const ctx of contexts) {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

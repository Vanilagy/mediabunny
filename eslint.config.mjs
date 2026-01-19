import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
	eslint.configs.recommended,
	tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	stylistic.configs.customize({
		indent: 'tab',
		quotes: 'single',
		semi: true,
		braceStyle: '1tbs',
	}),
	{
		rules: {
			'@stylistic/max-len': ['error', {
				code: 120,
			}],
			'curly': ['error', 'multi-line'],
			'eqeqeq': ['error', 'always', { null: 'ignore' }],
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/require-await': 'off',
			'@stylistic/yield-star-spacing': ['error', { before: false, after: true }],
			'@typescript-eslint/no-unsafe-enum-comparison': 'off',
		},
	},
	{
		ignores: [
			'dist',
			'dist-docs',
			'packages/mp3-encoder/dist',
			'packages/mp3-encoder/build',
			'eslint.config.mjs',
			'docs/.vitepress/cache',
			'test/public',
		]
	}
);

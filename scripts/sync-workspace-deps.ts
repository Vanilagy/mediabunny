import fs from 'node:fs';
import path from 'node:path';

// After `npm version --workspaces` bumps each package's version, this rewrites dependency ranges that point at sibling
// workspaces so they follow along.

const root = path.join(import.meta.dirname, '..');

const workspaceDirs = ['.', ...fs.readdirSync(path.join(root, 'packages')).map(x => `packages/${x}`)]
	.filter(dir => fs.existsSync(path.join(root, dir, 'package.json')));

type Manifest = {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
};

const manifests = workspaceDirs.map((dir) => {
	const filePath = path.join(root, dir, 'package.json');
	return { filePath, json: JSON.parse(fs.readFileSync(filePath, 'utf8')) as Manifest };
});

const versions = new Map(manifests.map(({ json }) => [json.name, json.version]));

for (const { filePath, json } of manifests) {
	let changed = false;

	for (const name of Object.keys(json.dependencies ?? {})) {
		const version = versions.get(name);
		if (version && json.dependencies![name] !== `^${version}`) {
			json.dependencies![name] = `^${version}`;
			changed = true;
		}
	}

	if (changed) {
		fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + '\n');
		console.log(`Synced workspace dependency ranges in ${path.relative(root, filePath)}`);
	}
}

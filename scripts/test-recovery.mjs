import { mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const directory = mkdtempSync(join('test/public/', 'recovery-fixtures-'));
/** @param {string} command @param {string[]} args @param {NodeJS.ProcessEnv} env */
const run = (command, args, env = process.env) => {
	const result = spawnSync(command, args, { stdio: 'inherit', env });
	if (result.error || result.status !== 0) {
		throw result.error ?? new Error(`${command} exited ${result.status}`);
	}
};
try {
	for (const [encoder, extension] of [
		['libmp3lame', 'mp3'], ['flac', 'flac'], ['vorbis', 'ogg'],
		['ac3', 'ac3.mkv'], ['eac3', 'eac3.mkv'], ['dca', 'dts.mkv'],
	]) {
		run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
			'aevalsrc=0.3*sin(2*PI*(440*t+200*t*t))+0.04*sin(2*PI*7013*t):s=48000:d=3',
			'-ac', '2', '-c:a', encoder, '-strict', '-2', join(directory, `recovery.${extension}`)]);
	}
	run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=12',
		'-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12', '-c:v', 'libx264',
		'-bf', '3', '-g', '30', '-c:a', 'aac', join(directory, 'recovery-bframes.mp4')]);
	run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=12',
		'-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-g', '30',
		join(directory, 'recovery-copy.webm')]);
	run('./node_modules/.bin/vitest', ['run', '--project', 'browser', 'test/browser/conversion-recovery.test.ts',
		'--reporter', 'verbose', ...process.argv.slice(2)], {
		...process.env, RECOVERY_TEST_MEDIA: '/' + basename(directory),
	});
} finally {
	rmSync(directory, { recursive: true, force: true });
}

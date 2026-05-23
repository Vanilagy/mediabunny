import {
	ALL_FORMATS,
	AudioSampleSink,
	Input,
	StreamSource,
} from '../dist/bundles/mediabunny.mjs';

/**
 * Repro for the mediabunny 1.42.0 memory leak.
 *
 * Root cause: the `StreamSource` read callback closes over `this.reader`, which
 * stores the resolved `InputAudioTrack`. `InputAudioTrack.input` is a strong
 * back-reference to `Input`, completing the cycle:
 *
 *   FinalizationRegistry (live GC root)
 *     -> _sourceRefs: SourceRef[]           (held value, held strongly)
 *     -> SourceRef.source: StreamSource
 *     -> read callback closure
 *     -> reader.track: InputAudioTrack
 *     -> InputAudioTrack.input: Input        <- registry target
 *
 * The held value reaches the target, so the target is never unreachable.
 * The registry never fires. `Input.dispose()` is never called.
 * `ReadOrchestrator.cache` (~8 MiB per file) is retained permanently.
 *
 * Steps to observe:
 *   1. Open DevTools -> Memory, select the Worker context.
 *   2. Select 5+ audio files and click Choose File(s).
 *   3. Take a heap snapshot. Observe JSArrayBufferData growth (~8 MiB per file).
 *   4. Click "Collect garbage" - memory does not drop.
 *
 * Workaround: call `input.dispose()` before MbFrameSource.init() returns and
 * repeat test. Memory usage would recover. Not easy to know when it should be called
 * in the full implementation, so best if we can rely on normal GC.
 */

// Mockup of our custom reader.
class BlobBinaryReader {
	constructor(src) {
		this.src = src;
	}

	async read(start, end) {
		return new Uint8Array(await this.src.slice(start, end).arrayBuffer());
	}

	async byteLength() {
		return this.src.size;
	}
}

class MbFrameSource {
	static async create(reader) {
		const fs = new MbFrameSource(reader);
		await fs.init();
		return fs;
	}

	get track() {
		return this._track;
	}

	constructor(sourceReader) {
		this._track = null;
		this.reader = sourceReader;
	}

	async init() {
		const source = new StreamSource({
			prefetchProfile: 'fileSystem',
			read: (start, end) => this.reader.read(start, end),
			getSize: () => this.reader.byteLength(),
		});

		const input = new Input({
			source: source,
			formats: ALL_FORMATS,
		});

		// Assigning back to reader.track closes the cycle through the
		// FinalizationRegistry's held value, preventing Input from ever being
		// considered unreachable. ~8 MiB of ReadOrchestrator.cache leaks here.
		this._track = await input.getPrimaryAudioTrack();

		// Uncomment to get it to work.
		// input.dispose();
	}
}

// Mockup of our clip.
class MbAudClip {
	static async create(frameSource) {
		const clip = new MbAudClip();
		await clip.init(frameSource);
		return clip;
	}

	constructor() {
		this.sampleSink = undefined;
	}

	async init(frameSource) {
		const audioTrack = frameSource.track;
		if (!audioTrack) {
			throw new Error('Could not get audio track.');
		}
		this.sampleSink = new AudioSampleSink(audioTrack);
	}

	async play() {
		if (!this.sampleSink) {
			throw new Error('Attempting to play without initializing.');
		}

		// This is where playing would happen, but not needed to demo the issue.
	}
}

const loadFile = async (file) => {
	const reader = new BlobBinaryReader(new Blob([file], { type: file.type }));
	const frameSource = await MbFrameSource.create(reader);
	const clip = await MbAudClip.create(frameSource);

	await clip.play();
};

self.onmessage = (e) => {
	if (e.data.type === 'loadFile') {
		loadFile(e.data.file)
			.then(() => {
				self.postMessage({ type: 'done' });
			})
			.catch((err) => {
				self.postMessage({ type: 'error', message: String(err) });
			});
	}
};

import { afterEach, expect, test, vi } from 'vitest';
import {
	canEncodeVideo,
	canEncodeVideoMemo,
	getEncodableVideoCodecs,
	getFirstEncodableVideoCodec,
	Quality,
} from '../../src/encode.js';
import { CustomVideoEncoder, customVideoEncoders } from '../../src/custom-coder.js';

class AlwaysSupportedVideoEncoder extends CustomVideoEncoder {
	static override supports = () => true;
	override init = () => {};
	override encode = () => {};
	override flush = () => {};
	override close = () => {};
}

afterEach(() => {
	vi.unstubAllGlobals();
	canEncodeVideoMemo.clear();
});

test('config-only checks the requested frame rate with the native encoder', async () => {
	const queriedConfigs: VideoEncoderConfig[] = [];
	vi.stubGlobal('VideoEncoder', {
		isConfigSupported: (config: VideoEncoderConfig) => {
			queriedConfigs.push(config);
			return Promise.resolve({ config, supported: true });
		},
	});

	const supported = await canEncodeVideo('avc', {
		width: 1080,
		height: 1920,
		quality: new Quality({ bitrate: 4_000_000 }),
		framerate: 30,
		checkMode: 'config-only',
	});

	expect(supported).toBe(true);
	expect(queriedConfigs).toHaveLength(1);
	expect(queriedConfigs[0]).toMatchObject({
		width: 1080,
		height: 1920,
		bitrate: 4_000_000,
		framerate: 30,
	});
});

test('config-only performs a fresh native support query on each call', async () => {
	let queryCount = 0;
	vi.stubGlobal('VideoEncoder', {
		isConfigSupported: (config: VideoEncoderConfig) => Promise.resolve({
			config,
			supported: ++queryCount === 2,
		}),
	});
	const options = {
		quality: new Quality({ bitrate: 1_000_000 }),
		checkMode: 'config-only' as const,
	};

	expect(await canEncodeVideo('avc', options)).toBe(false);
	expect(await canEncodeVideo('avc', options)).toBe(true);
});

test('config-only tries the fallback native configuration when the preferred one is unsupported', async () => {
	let queryCount = 0;
	vi.stubGlobal('VideoEncoder', {
		isConfigSupported: (config: VideoEncoderConfig) => Promise.resolve({
			config,
			supported: ++queryCount === 2,
		}),
	});

	const supported = await canEncodeVideo('vp9', {
		quality: new Quality({ quantizer: 20, bitrate: 1_000_000 }),
		checkMode: 'config-only',
	});

	expect(supported).toBe(true);
	expect(queryCount).toBe(2);
});

test('config-only propagates native support query errors', async () => {
	const error = new TypeError('Unsupported configuration field.');
	vi.stubGlobal('VideoEncoder', {
		isConfigSupported: () => Promise.reject(error),
	});

	await expect(canEncodeVideo('avc', { checkMode: 'config-only' })).rejects.toBe(error);
});

test('config-only ignores custom encoders when the native video encoder is unavailable', async () => {
	vi.stubGlobal('VideoEncoder', undefined);
	customVideoEncoders.push(AlwaysSupportedVideoEncoder);

	try {
		expect(await canEncodeVideo('avc', { checkMode: 'config-only' })).toBe(false);
	} finally {
		customVideoEncoders.pop();
	}
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
	'rejects invalid frame rate %s',
	async (framerate) => {
		await expect(canEncodeVideo('avc', { framerate })).rejects.toThrow(
			'framerate, when provided, must be a finite positive number.',
		);
	},
);

test('rejects an unknown support check mode', async () => {
	await expect(canEncodeVideo('avc', { checkMode: 'unknown' as 'auto' })).rejects.toThrow(
		'checkMode must be \'auto\' or \'config-only\'.',
	);
});

test('video codec helpers forward frame rate and config-only mode', async () => {
	const queriedFrameRates: Array<number | undefined> = [];
	vi.stubGlobal('VideoEncoder', {
		isConfigSupported: (config: VideoEncoderConfig) => {
			queriedFrameRates.push(config.framerate);
			return Promise.resolve({ config, supported: true });
		},
	});
	const options = {
		framerate: 24,
		checkMode: 'config-only' as const,
	};

	expect(await getEncodableVideoCodecs(['avc'], options)).toEqual(['avc']);
	expect(await getFirstEncodableVideoCodec(['avc'], options)).toBe('avc');
	expect(queriedFrameRates).toEqual([24, 24]);
});

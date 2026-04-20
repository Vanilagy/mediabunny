/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { isChromium } from './misc';

/**
 * Workaround for a Chromium 147 regression in which Canvas2D `drawImage(VideoFrame)`
 * (and `createImageBitmap(VideoFrame)`) silently produces an all-black canvas for some
 * hardware-decoded `VideoFrame`s — most notably HEVC Range Extensions (e.g. 4:2:2 10-bit,
 * `format === null`), but other 10-bit / 4:2:2 hardware frames are also affected.
 *
 * Bisect of Chrome for Testing builds: 147.0.7705.0 PASSes, 147.0.7706.0 FAILs.
 * The change of behavior corresponds to a Blink refactor of how `StaticBitmapImage`s
 * are created from `VideoFrame`s (Canvas2D path). WebGL `texImage2D(VideoFrame)` still
 * works correctly because it goes through a different upload path.
 *
 * Strategy:
 *  1. On the first `toCanvasImageSource()` call for each distinct `VideoFrame.format`
 *     value, we probe by drawing the frame into a tiny throwaway Canvas2D and reading
 *     a few pixels back. If every sampled pixel has zero RGB, we mark this format as
 *     "broken on this Chromium build".
 *  2. For broken formats, we reroute via a shared WebGL helper that uploads the
 *     `VideoFrame` to a texture and renders it to an `OffscreenCanvas` /
 *     `HTMLCanvasElement`, which is then returned in place of the `VideoFrame`.
 *  3. The cache is keyed by `VideoFrame.format` (including `null`), so non-broken
 *     formats incur no overhead beyond a one-time probe.
 *  4. The helper auto-disables itself if WebGL is unavailable or the upload throws,
 *     in which case callers fall back to the original (broken) Canvas2D path so
 *     non-affected frames keep working.
 */

type WebGLHelper = {
	canvas: HTMLCanvasElement | OffscreenCanvas;
	gl: WebGLRenderingContext;
	program: WebGLProgram;
	texture: WebGLTexture;
};

let webGLHelper: WebGLHelper | null | undefined;
const formatProbeCache = new Map<string, boolean>();

const probeCanvas2dResultIsBlack = (
	context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	width: number,
	height: number,
) => {
	try {
		const w = Math.max(1, Math.min(width, 4));
		const h = Math.max(1, Math.min(height, 4));
		const data = context.getImageData(0, 0, w, h).data;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i]! | data[i + 1]! | data[i + 2]!) {
				return false;
			}
		}
		return true;
	} catch {
		// Tainted canvas, OOM, etc. — treat as "not provably black" to avoid false positives.
		return false;
	}
};

const initWebGLHelper = (): WebGLHelper | null => {
	if (webGLHelper !== undefined) {
		return webGLHelper;
	}

	let canvas: HTMLCanvasElement | OffscreenCanvas;
	if (typeof document !== 'undefined') {
		canvas = document.createElement('canvas');
	} else if (typeof OffscreenCanvas !== 'undefined') {
		canvas = new OffscreenCanvas(1, 1);
	} else {
		return webGLHelper = null;
	}

	const gl = canvas.getContext('webgl', {
		premultipliedAlpha: false,
		preserveDrawingBuffer: false,
		antialias: false,
		depth: false,
		stencil: false,
	});
	if (!gl) {
		return webGLHelper = null;
	}

	const compileShader = (type: number, source: string) => {
		const shader = gl.createShader(type);
		if (!shader) return null;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	};

	const vs = compileShader(
		gl.VERTEX_SHADER,
		'attribute vec2 a;varying vec2 v;void main(){v=vec2((a.x+1.0)*0.5,1.0-(a.y+1.0)*0.5);gl_Position=vec4(a,0,1);}',
	);
	const fs = compileShader(
		gl.FRAGMENT_SHADER,
		'precision mediump float;uniform sampler2D t;varying vec2 v;void main(){gl_FragColor=texture2D(t,v);}',
	);
	if (!vs || !fs) {
		return webGLHelper = null;
	}

	const program = gl.createProgram();
	if (!program) return webGLHelper = null;
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		return webGLHelper = null;
	}

	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

	const texture = gl.createTexture();
	if (!texture) return webGLHelper = null;
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

	gl.useProgram(program);
	const attr = gl.getAttribLocation(program, 'a');
	gl.enableVertexAttribArray(attr);
	gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);

	return webGLHelper = { canvas, gl, program, texture };
};

const renderVideoFrameViaWebGL = (videoFrame: VideoFrame): HTMLCanvasElement | OffscreenCanvas | null => {
	const helper = initWebGLHelper();
	if (!helper) return null;

	const { gl, canvas, texture } = helper;
	const w = videoFrame.codedWidth;
	const h = videoFrame.codedHeight;
	if (!w || !h) return null;

	if (canvas.width !== w) canvas.width = w;
	if (canvas.height !== h) canvas.height = h;

	gl.viewport(0, 0, w, h);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	try {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame);
	} catch {
		return null;
	}
	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	return canvas;
};

const probeFormatNeedsWebGL = (videoFrame: VideoFrame): boolean => {
	// Use a tiny canvas to keep the probe cheap — we only need a few pixels back.
	const probeWidth = Math.min(videoFrame.codedWidth || 1, 16);
	const probeHeight = Math.min(videoFrame.codedHeight || 1, 16);
	let probeCanvas: HTMLCanvasElement | OffscreenCanvas;
	if (typeof OffscreenCanvas !== 'undefined') {
		probeCanvas = new OffscreenCanvas(probeWidth, probeHeight);
	} else if (typeof document !== 'undefined') {
		probeCanvas = document.createElement('canvas');
		probeCanvas.width = probeWidth;
		probeCanvas.height = probeHeight;
	} else {
		return false;
	}

	const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return false;

	try {
		ctx.drawImage(videoFrame, 0, 0, probeWidth, probeHeight);
	} catch {
		return false;
	}

	return probeCanvas2dResultIsBlack(ctx, probeWidth, probeHeight);
};

/**
 * Returns a `CanvasImageSource` that is safe to pass to `Canvas2D.drawImage()` on
 * the current Chromium build. For most frames this is the input `VideoFrame` itself.
 * For frame formats that are affected by the Chromium 147+ Canvas2D regression,
 * a freshly-rendered canvas (via WebGL `texImage2D`) is returned instead.
 *
 * The shared canvas is reused across calls, so callers must consume the result
 * immediately (e.g. inside the same synchronous `drawImage` call).
 *
 * @internal
 */
export const maybeRewriteVideoFrameForCanvas2d = (
	videoFrame: VideoFrame,
): VideoFrame | HTMLCanvasElement | OffscreenCanvas => {
	if (!isChromium()) return videoFrame;

	// `VideoFrame.format` can legitimately be `null` (e.g. HEVC Rext on Chromium),
	// which is in fact the most common affected case — keep the cache key faithful.
	const cacheKey = videoFrame.format ?? '<null>';
	let needsWebGL = formatProbeCache.get(cacheKey);
	if (needsWebGL === undefined) {
		needsWebGL = probeFormatNeedsWebGL(videoFrame);
		formatProbeCache.set(cacheKey, needsWebGL);
	}
	if (!needsWebGL) return videoFrame;

	const rendered = renderVideoFrameViaWebGL(videoFrame);
	if (!rendered) return videoFrame;
	return rendered;
};

/**
 * Test-only escape hatch: clears the per-format probe cache and tears down the
 * shared WebGL helper. Callers should not rely on this in production.
 *
 * @internal
 */
export const __resetChromiumVideoFrameCanvasFallbackForTests = () => {
	formatProbeCache.clear();
	webGLHelper = undefined;
};

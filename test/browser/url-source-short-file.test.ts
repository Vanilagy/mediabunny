import { test } from 'vitest';
import { UrlSource } from '../../src/source.js';
import { ALL_FORMATS } from '../../src/input-format.js';
import { Input } from '../../src/input.js';

test('Should be able to get track from a very small video file (512kb)', async () => {
    const source = new UrlSource('/frames.webm');
    const input = new Input({
        source,
        formats: ALL_FORMATS,
    });
    const primaryVideoTrack = await input.getPrimaryVideoTrack();
    console.log(input)
});
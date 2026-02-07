const hlsInput = new ManifestInput({
	source: new UrlSource('https://example.com/playlist.m3u8'),
	formats: [HLS],
});

const variants = await hlsInput.getVariants();
const bestVariant = await hlsInput.getPrimaryVariant();
const qualityVariant = await hlsInput.getVariantFor('1080p'); // In spirit

bestVariant.tracks; // ?
bestVariant.bitrate; // ?
bestVariant.isLive(); // ?

const input = variant.toInput(); // => Input
const segments = variant.getSegments(); // => Segments[]?

const segment = variant.getFirstSegment();
segment.path; // => string (for example 'segment1.ts')
segment.timestamp; // => 10
segment.duration; // 5
segment.toInput(); // => Input

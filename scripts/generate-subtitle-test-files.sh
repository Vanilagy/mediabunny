#!/bin/bash

# Generate subtitle test files for MediaBunny
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/test/public/subtitles"

mkdir -p "$OUTPUT_DIR"
cd "$OUTPUT_DIR"

echo "Generating subtitle test files..."

# Create test SRT subtitle file
cat > test.srt << 'EOF'
1
00:00:01,000 --> 00:00:03,500
Hello world!

2
00:00:05,000 --> 00:00:07,000
This is a test.

3
00:00:08,500 --> 00:00:10,000
Goodbye!
EOF

# Create test ASS subtitle file
cat > test.ass << 'EOF'
[Script Info]
Title: Test Subtitles
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world!
Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,This is a test.
Dialogue: 0,0:00:08.50,0:00:10.00,Default,,0,0,0,,Goodbye!
EOF

# Create test SSA subtitle file (older format)
cat > test.ssa << 'EOF'
[Script Info]
Title: Test Subtitles
ScriptType: v4.00

[V4 Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, TertiaryColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, AlphaLevel, Encoding
Style: Default,Arial,20,16777215,65535,65535,0,0,0,1,2,0,2,10,10,10,0,1

[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello world!
Dialogue: Marked=0,0:00:05.00,0:00:07.00,Default,,0,0,0,,This is a test.
Dialogue: Marked=0,0:00:08.50,0:00:10.00,Default,,0,0,0,,Goodbye!
EOF

# Create test WebVTT subtitle file
cat > test.vtt << 'EOF'
WEBVTT

00:00:01.000 --> 00:00:03.500
Hello world!

00:00:05.000 --> 00:00:07.000
This is a test.

00:00:08.500 --> 00:00:10.000
Goodbye!
EOF

echo "Creating test video (10 seconds, black screen)..."

# Generate test video (black screen, 10 seconds, with audio)
ffmpeg -y -f lavfi -i color=black:s=1280x720:d=10 -f lavfi -i anullsrc=r=48000:cl=stereo:d=10 \
  -c:v libx264 -preset ultrafast -c:a aac -shortest test-video.mp4 \
  -loglevel warning

echo "Creating MKV with SRT subtitle..."
ffmpeg -y -i test-video.mp4 -i test.srt \
  -c:v copy -c:a copy -c:s srt \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  test-mkv-srt.mkv -loglevel warning

echo "Creating MKV with ASS subtitle..."
ffmpeg -y -i test-video.mp4 -i test.ass \
  -c:v copy -c:a copy -c:s ass \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  test-mkv-ass.mkv -loglevel warning

echo "Creating MKV with SSA subtitle..."
ffmpeg -y -i test-video.mp4 -i test.ssa \
  -c:v copy -c:a copy -c:s ssa \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  test-mkv-ssa.mkv -loglevel warning

echo "Creating MKV with WebVTT subtitle..."
ffmpeg -y -i test-video.mp4 -i test.vtt \
  -c:v copy -c:a copy -c:s webvtt \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  test-mkv-vtt.mkv -loglevel warning

echo "Creating MKV with multiple subtitle tracks..."
ffmpeg -y -i test-video.mp4 -i test.srt -i test.ass \
  -map 0:v -map 0:a -map 1:s -map 2:s \
  -c:v copy -c:a copy -c:s srt -c:s:1 ass \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English SRT" \
  -metadata:s:s:1 language=spa -metadata:s:s:1 title="Spanish ASS" \
  test-mkv-multi.mkv -loglevel warning

echo "Creating MP4 with WebVTT subtitle (mov_text codec)..."
ffmpeg -y -i test-video.mp4 -i test.vtt \
  -c:v copy -c:a copy -c:s mov_text \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="English" \
  test-mp4-vtt.mp4 -loglevel warning

echo "Creating MKV with ASS subtitle with fonts/graphics sections..."
ffmpeg -y -i test-video.mp4 -i test-with-fonts.ass \
  -c:v copy -c:a copy -c:s ass \
  -metadata:s:s:0 language=eng -metadata:s:s:0 title="With Fonts" \
  test-mkv-ass-fonts.mkv -loglevel warning

echo ""
echo "✓ Test files generated successfully in $OUTPUT_DIR"
echo ""
echo "Files created:"
ls -lh test-*.mkv test-*.mp4 test*.srt test*.ass test*.ssa test*.vtt 2>/dev/null | awk '{print "  " $9 " (" $5 ")"}'

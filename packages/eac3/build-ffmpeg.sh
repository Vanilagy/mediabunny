#!/bin/bash

set -e

ORIGINAL_DIR="$(pwd)"
FFMPEG_VERSION="7.1.2"
BUILD_DIR="ffmpeg-build"
INSTALL_DIR="$(pwd)/eac3-build"

if [ ! -d "$BUILD_DIR" ]; then
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"

    echo "Downloading FFmpeg $FFMPEG_VERSION..."
    curl -L "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o ffmpeg.tar.xz
    tar -xf ffmpeg.tar.xz
    cd "ffmpeg-$FFMPEG_VERSION"
else
    cd "$BUILD_DIR/ffmpeg-$FFMPEG_VERSION"
fi

echo "Configuring FFmpeg for WASM (libavcodec + libavutil only for EAC3)..."

export PKG_CONFIG_PATH=""

emconfigure ./configure \
    --prefix="$INSTALL_DIR" \
    --target-os=none \
    --arch=x86_32 \
    --enable-cross-compile \
    --disable-programs \
    --disable-doc \
    --disable-swresample \
    --disable-swscale \
    --disable-postproc \
    --disable-avfilter \
    --disable-avformat \
    --disable-avdevice \
    --disable-network \
    --disable-debug \
    --disable-stripping \
    --enable-small \
    --enable-gpl \
    --enable-version3 \
    --enable-nonfree \
    --disable-decoders \
    --enable-decoder=eac3 \
    --enable-decoder=ac3 \
    --disable-encoders \
    --enable-encoder=eac3 \
    --enable-encoder=ac3 \
    --disable-parsers \
    --enable-parser=ac3 \
    --disable-demuxers \
    --disable-muxers \
    --disable-protocols \
    --disable-asm \
    --disable-x86asm \
    --disable-inline-asm \
    --disable-pthreads \
    --disable-w32threads \
    --disable-os2threads \
    --disable-vulkan \
    --disable-cuda \
    --disable-cuvid \
    --disable-nvenc \
    --disable-vaapi \
    --disable-vdpau \
    --disable-videotoolbox \
    --cc=emcc \
    --cxx=em++ \
    --ar=emar \
    --ranlib=emranlib \
    --extra-cflags="-O3 -fno-exceptions -fno-rtti -flto -msimd128 -ffast-math" \
    --extra-cxxflags="-O3 -fno-exceptions -fno-rtti -flto -msimd128" \
    --extra-ldflags="-O3 -flto -s INITIAL_MEMORY=33554432" \
    --pkg-config-flags="--static"

echo "Building FFmpeg libraries..."
emmake make -j$(sysctl -n hw.ncpu)

echo "Installing libraries..."
emmake make install

echo "Build complete! Libraries installed in $INSTALL_DIR"
echo "Static libraries:"
ls -la "$INSTALL_DIR/lib/"*.a
echo ""
echo "Copying to lib directory..."
mkdir -p "$ORIGINAL_DIR/lib"
if [ -d "$ORIGINAL_DIR/lib" ]; then
    echo "Directory created: $ORIGINAL_DIR/lib"
else
    echo "Failed to create directory: $ORIGINAL_DIR/lib"
fi

echo "Copying $INSTALL_DIR/lib/libavcodec.a to $ORIGINAL_DIR/lib/libavcodec.a"
cp "$INSTALL_DIR/lib/libavcodec.a" "$ORIGINAL_DIR/lib/libavcodec.a"
if [ -f "$ORIGINAL_DIR/lib/libavcodec.a" ]; then
    echo "Success: libavcodec.a copied successfully."
else
    echo "Error: Failed to copy libavcodec.a."
fi

echo "Copying $INSTALL_DIR/lib/libavutil.a to $ORIGINAL_DIR/lib/libavutil.a"
cp "$INSTALL_DIR/lib/libavutil.a" "$ORIGINAL_DIR/lib/libavutil.a"
if [ -f "$ORIGINAL_DIR/lib/libavutil.a" ]; then
    echo "Success: libavutil.a copied successfully."
else
    echo "Error: Failed to copy libavutil.a."
fi

echo "Copying header files..."
mkdir -p "$ORIGINAL_DIR/lib"

# Copy all libavcodec headers
echo "Copying libavcodec headers..."
cp "$INSTALL_DIR/include/libavcodec/"*.h "$ORIGINAL_DIR/lib/" 2>/dev/null || true

# Copy all libavutil headers
echo "Copying libavutil headers..."
cp "$INSTALL_DIR/include/libavutil/"*.h "$ORIGINAL_DIR/lib/" 2>/dev/null || true

echo ""
echo "Contents of lib directory:"
ls -la "$ORIGINAL_DIR/lib/"

echo "Done! Libraries ready in packages/eac3/lib/"

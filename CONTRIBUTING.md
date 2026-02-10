# Contributing to Mediabunny

Thanks for your interest in contributing to Mediabunny! This guide will help you get started.

## Code of Conduct

Be respectful, constructive, and collaborative. We're building a powerful media toolkit for the web - let's make it great together.

## Ways to Contribute

- **Report bugs** - Found something broken? Let us know
- **Suggest features** - Have ideas for improvements? We'd love to hear them
- **Fix issues** - Check our [issue tracker](https://github.com/Vanilagy/mediabunny/issues)
- **Improve docs** - Documentation improvements are always welcome
- **Add format support** - Help us support more media formats
- **Add codec support** - Implement new codec parsers or encoders
- **Optimize performance** - Help make Mediabunny faster
- **Add tests** - Improve test coverage

## Getting Started

### Prerequisites

- **Node.js 20+** - Modern version required
- **npm** - Package manager
- **TypeScript 5.7+** - For type checking
- **Modern browser** - For testing (Chrome, Firefox, Safari, or Edge)

### Development Setup

1. **Fork and clone the repository**

```bash
git clone https://github.com/YOUR_USERNAME/mediabunny.git
cd mediabunny
```

2. **Install dependencies**

```bash
npm install
```

3. **Build the project**

```bash
npm run build
```

4. **Start development**

```bash
# Watch mode (rebuilds on changes)
npm run watch

# Start examples server
npm run dev
# Open http://localhost:5173/examples/[name]/
```

5. **Run tests**

```bash
npm test
```

### Project Structure

```
mediabunny/
├── src/
│   ├── isobmff/            # MP4/MOV format
│   ├── matroska/           # WebM/MKV format
│   ├── wave/               # WAVE format
│   ├── mp3/                # MP3 format
│   ├── ogg/                # Ogg format
│   ├── adts/               # ADTS format
│   ├── flac/               # FLAC format
│   ├── mpeg-ts/            # MPEG-TS format
│   ├── demuxer.ts          # Demuxer base
│   ├── muxer.ts            # Muxer base
│   ├── codec.ts            # Codec handling
│   ├── conversion.ts       # Conversion API
│   └── index.ts            # Main exports
├── packages/
│   └── mp3-encoder/        # MP3 encoder package
├── examples/               # Example applications
├── test/                   # Test files
│   ├── browser/            # Browser tests
│   └── node/               # Node.js tests
├── docs/                   # Documentation site
└── scripts/                # Build scripts
```

## Development Workflow

### 1. Create a feature branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/issue-description
```

### 2. Make your changes

- Write clear, focused commits
- Follow existing code style
- Add tests for new features
- Update documentation if needed
- Ensure TypeScript types are correct

### 3. Run checks

```bash
# Type checking
npm run check

# Linting
npm run lint

# Tests
npm test

# Build
npm run build
```

### 4. Test your changes

```bash
# Test with examples
npm run dev
# Open http://localhost:5173/examples/

# Test in browser
npm run test-browser

# Test in Node.js
npm run test-node
```

### 5. Commit your changes

```bash
git add .
git commit -m "feat: add support for X"
# or
git commit -m "fix: resolve issue with Y"
```

Use conventional commit format:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `test:` - Adding tests
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `chore:` - Maintenance tasks

### 6. Push and create a Pull Request

```bash
git push origin feature/your-feature-name
```

Then open a PR on GitHub with:
- Clear description of what changed and why
- Reference any related issues (`Fixes #123`)
- Include test results
- Add examples if applicable

## Common Tasks

### Adding a New Container Format

1. **Create format directory** in `src/[format-name]/`
2. **Implement demuxer** - Extend `Demuxer` base class
3. **Implement muxer** - Extend `Muxer` base class
4. **Add format class** - Create `[Format]InputFormat` and `[Format]OutputFormat`
5. **Add tests** - Create test files in `test/`
6. **Update exports** - Add to `src/index.ts`
7. **Document** - Add to docs and examples

### Adding Codec Support

1. **Update codec data** in `src/codec-data.ts`
2. **Add codec parser** if needed
3. **Add encoder/decoder** if implementing custom codec
4. **Add tests** - Test with real media files
5. **Document** - Update codec support list

### Fixing a Bug

1. **Reproduce the issue** - Verify you can reproduce it
2. **Write a failing test** - Add a test that fails with the bug
3. **Fix the bug** - Make the test pass
4. **Verify** - Run all tests to ensure no regressions
5. **Test with examples** - Verify fix works in real scenarios

### Improving Performance

1. **Profile the code** - Use browser DevTools or Node.js profiler
2. **Identify bottlenecks** - Find slow operations
3. **Optimize** - Improve performance
4. **Benchmark** - Measure improvement
5. **Test** - Ensure correctness is maintained

## Pull Request Guidelines

### Before Submitting

- [ ] Code builds without errors (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] Type checking passes (`npm run check`)
- [ ] Linting passes (`npm run lint`)
- [ ] Documentation is updated if needed
- [ ] Commit messages follow conventional format
- [ ] PR description explains what and why
- [ ] Examples work if applicable

### PR Title Format

Use conventional commit format:
```
feat(mp4): add support for HDR metadata
fix(webm): resolve timestamp calculation issue
docs: improve conversion API examples
perf(demuxer): optimize packet reading
```

### Review Process

1. Maintainers will review your PR
2. Address any feedback or requested changes
3. Once approved, a maintainer will merge

## Tech Stack

- **TypeScript** - Pure TypeScript implementation
- **WebCodecs API** - Hardware-accelerated encoding/decoding
- **esbuild** - Fast bundling
- **Vite** - Development server and examples
- **VitePress** - Documentation site
- **Vitest** - Testing framework

## Architecture Overview

Mediabunny uses a **pipelined architecture**:

```
Input → Demuxer → Decoder → Processor → Encoder → Muxer → Output
```

**Key concepts:**

1. **Demuxers** - Parse container formats, extract packets
2. **Muxers** - Write container formats, package packets
3. **Codecs** - Encode/decode audio and video
4. **Sources** - Provide input data (files, streams, canvas, etc.)
5. **Targets** - Receive output data (buffers, streams, etc.)
6. **Conversion API** - High-level API for common operations

## Format Implementation Guidelines

### Demuxer Implementation

```typescript
export class MyFormatDemuxer extends Demuxer {
    async readHeader() {
        // Parse format header
        // Extract track information
        // Set up track metadata
    }

    async readPacket() {
        // Read next packet from stream
        // Return packet with timestamp and data
    }
}
```

### Muxer Implementation

```typescript
export class MyFormatMuxer extends Muxer {
    async writeHeader() {
        // Write format header
        // Initialize tracks
    }

    async writePacket(packet: Packet) {
        // Write packet to stream
        // Handle timestamps and interleaving
    }

    async writeTrailer() {
        // Finalize file
        // Write index/metadata
    }
}
```

## Testing Guidelines

### Unit Tests

- Test individual functions and classes
- Mock external dependencies
- Use Vitest for testing

```typescript
import { describe, it, expect } from 'vitest';

describe('MyFormat', () => {
    it('should parse header correctly', () => {
        // Test implementation
    });
});
```

### Integration Tests

- Test with real media files
- Test format reading and writing
- Test conversion workflows

### Browser Tests

```bash
npm run test-browser
```

### Node.js Tests

```bash
npm run test-node
```

## Code Style

- Use TypeScript for all code
- Follow existing code formatting
- Use meaningful variable names
- Add JSDoc comments for public APIs
- Keep functions focused and small
- Prefer immutability where possible
- Use async/await over promises

## Documentation

Documentation lives in:
- `README.md` - Main documentation
- `docs/` - Comprehensive guides and API docs
- `examples/` - Working code examples
- Code comments - Inline documentation

### Updating API Docs

```bash
npm run docs:generate
```

### Testing Docs Locally

```bash
npm run docs:dev
```

## Performance Considerations

- **Memory efficiency** - Use streaming for large files
- **CPU efficiency** - Minimize allocations and copies
- **Tree-shaking** - Keep code modular and tree-shakable
- **Bundle size** - Avoid unnecessary dependencies
- **WebCodecs** - Use hardware acceleration when available

## License

Mediabunny is licensed under the **Mozilla Public License 2.0 (MPL-2.0)**. This is a weak copyleft license that:

- ✅ Allows commercial use
- ✅ Allows closed-source projects
- ✅ Allows modification
- ✅ Requires sharing modifications to Mediabunny itself

By contributing, you agree that your contributions will be licensed under the MPL-2.0.

### License Headers

All source files must include the MPL-2.0 license header:

```typescript
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
```

The build script automatically ensures license headers are present.

## Getting Help

- **GitHub Issues** - [Report bugs or request features](https://github.com/Vanilagy/mediabunny/issues)
- **Discord** - [Join the community](https://discord.gg/hmpkyYuS4U)
- **Documentation** - [mediabunny.dev](https://mediabunny.dev)
- **Sponsoring** - [Support development](https://github.com/sponsors/Vanilagy)

## Sponsoring

Mediabunny is free and open-source, but requires significant effort to maintain and expand. If you've derived value from this project, please consider [sponsoring it](https://github.com/sponsors/Vanilagy). Your support helps ensure continued development and maintenance.

---

Thank you for contributing to Mediabunny! 🩷

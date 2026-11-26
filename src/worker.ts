/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { colorAlphaMergerWorkerCode } from './decode';
import { colorAlphaSplitterWorkerCode, mediaStreamTrackProcessorWorkerCode } from './media-source';
import { unthrottledTimerWorkerCode } from './misc';

switch (self.name) {
	case 'unthrottled-timer':
		unthrottledTimerWorkerCode();
		break;
	case 'color-alpha-splitter':
		colorAlphaSplitterWorkerCode();
		break;
	case 'color-alpha-merger':
		colorAlphaMergerWorkerCode();
		break;
	case 'media-stream-track-processor':
		mediaStreamTrackProcessorWorkerCode();
		break;
	default:
		throw new Error(`Unknown worker name '${self.name}'.`);
}

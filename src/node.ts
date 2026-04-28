/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// This file contains Node.js-specific code that does not run in a browser.

// Dynamic import so it can be included in the bundles and still work properly in the browser

export * as fs from 'node:fs/promises';

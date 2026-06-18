/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { EventEmitter, type EventListenerOptions } from './misc';

/**
 * Controls how much information Mediabunny prints to the console. Higher levels include all lower levels.
 *
 * @group Logging
 * @public
 */
export enum LogLevel {
	/** Nothing is printed to the console. */
	Silent = 0,
	/** Only errors are printed. */
	Errors = 1,
	/** Errors and warnings are printed. */
	Warnings = 2,
	/** Errors, warnings, and informational messages are printed. */
	Info = 3,
}

/**
 * The events emitted by {@link Logging}. Each event carries the same arguments that were passed to the corresponding
 * log call.
 *
 * @group Logging
 * @public
 */
export type LoggingEvents = {
	/** Emitted before an error is logged. */
	error: unknown[];
	/** Emitted before a warning is logged. */
	warn: unknown[];
	/** Emitted before an informational message is logged. */
	info: unknown[];
};

/**
 * Mediabunny's central logging singleton. Use {@link Logging.level} to control how much is printed to the console,
 * and subscribe to log events using {@link Logging.on}.
 *
 * Having manual control over logging is useful for command-line applications where you want full say over the output.
 *
 * @group Logging
 * @public
 */
export class Logging {
	private constructor() {}

	/** @internal */
	static _level: LogLevel = LogLevel.Info;
	/** @internal */
	static _emitterInstance: EventEmitter<LoggingEvents> | null = null;

	/** The current log level. Defaults to {@link LogLevel.Info}. */
	static get level() {
		return Logging._level;
	}

	static set level(value: LogLevel) {
		if (
			value !== LogLevel.Silent
			&& value !== LogLevel.Errors
			&& value !== LogLevel.Warnings
			&& value !== LogLevel.Info
		) {
			throw new TypeError('Invalid log level. Use one of the values of the LogLevel enum.');
		}

		Logging._level = value;
	}

	/** @internal */
	static get _emitter() {
		// Created lazily to avoid touching the EventEmitter binding at module-eval time
		return Logging._emitterInstance ??= new EventEmitter<LoggingEvents>();
	}

	/** Registers a listener for a log event. Returns a function that, when called, removes the listener again. */
	static on<K extends keyof LoggingEvents>(
		event: K,
		listener: (data: LoggingEvents[K]) => unknown,
		options?: EventListenerOptions,
	) {
		return Logging._emitter.on(event, listener, options);
	}

	/** @internal */
	static _error(...args: unknown[]) {
		Logging._emitter._emit('error', args);

		if (Logging._level >= LogLevel.Errors) {
			console.error(...args);
		}
	}

	/** @internal */
	static _warn(...args: unknown[]) {
		Logging._emitter._emit('warn', args);

		if (Logging._level >= LogLevel.Warnings) {
			console.warn(...args);
		}
	}

	/** @internal */
	static _info(...args: unknown[]) {
		Logging._emitter._emit('info', args);

		if (Logging._level >= LogLevel.Info) {
			console.info(...args);
		}
	}
}

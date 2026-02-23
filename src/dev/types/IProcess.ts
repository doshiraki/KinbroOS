/*
 * Copyright 2026 @doshiraki
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * [Interface: IProcess]
 * 実行中のプロセスが持つコンテキスト情報の定義。
 * Provides access to stdio streams and environment variables.
 */

import { IEnvManager } from "./IEnvManager";
import { IFileSystem } from "./IFileSystem";

/**
 * Enum defining stream content (SourceKind)
 * Managed numerically for memory efficiency and speed.
 */

export const StreamData = {
    Uint8Array: 0,
    String: 1,
} as const;
export type StreamDataType = typeof StreamData[keyof typeof StreamData];

// ✨ 1. Enum Definition
export enum TTYMode {
    Raw = 0,
    Cooked = 1
}

export enum ProcessState {
    EMBRYO,       // Creating (Waiting for PID/PGID)
    RUNNING,      // Running
    SUSPENDED,    // Suspended (Parent waiting for child, etc.)
    ZOMBIE,       // Terminated but not reaped by parent
    TERMINATED    // Completely destroyed
}

// 1. Added: Error class representing signal termination
export class SignalError extends Error {
    constructor(public signal: number) {
        super(`Signal: ${signal}`);
    }
}

// 1. Generic resource interface
export interface IResource {
    close(): Promise<void>;
}

/**
 * Abstract interface for input streams
 * Used to decouple from implementation class (StdinStream).
 */
export interface IStdinStream {
    /** Connected to TTY (Terminal)? */
    readonly isTTY: boolean;
    
    /** ✨ Update: 文字列ではなく Enum を受け取る */
    setMode(mode: TTYMode): Promise<void>;

    // Added: Force interrupt reading
    interrupt(reason?: any): Promise<void>;

    /**
     * バイト列として読み込むためのReaderを取得する
     * (Error if locked)
     */
    getByteReader(): ReadableStreamDefaultReader<Uint8Array>;

    /**
     * 文字列として読み込むためのReaderを取得する
     * (Error if locked)
     */
    getStringReader(): ReadableStreamDefaultReader<string>;
}

/**
 * Abstract interface for output streams
 */
export interface IStdoutStream {
    readonly isTTY: boolean;

    // Added: Force interrupt reading
    interrupt(reason?: any): Promise<void>;
    
    /**
     * バイト列として書き込むためのWriterを取得する
     */
    getByteWriter(): WritableStreamDefaultWriter<Uint8Array>;

    /**
     * 文字列として書き込むためのWriterを取得する
     */
    getStringWriter(): WritableStreamDefaultWriter<string>;
}

export interface IProcess {
    /** Process ID (PID) */
    readonly pid: number;

    readonly state: ProcessState;
    setState(state: ProcessState):void;

    /** Process Group ID (PGID) */
    readonly pgid: number;

    /** Copy of environment variables (ReadOnly) */
    readonly env: IEnvManager;
    
    /** File System (ReadOnly) */
    readonly fs: IFileSystem;
    
    // --- Web Streams API Standard ---
    
    /** Standard Input (Stdin) */
    readonly stdin?: IStdinStream;

    /** Standard Output (Stdout) */
    readonly stdout?: IStdoutStream;

    /** Standard Error Output (Stderr) */
    readonly stderr?: IStdoutStream;

    wait(): Promise<number>;

    /**
     * Terminates the process
     * @param code Exit code (0: Success, >0: Error)
     */
    exit(code: number): void;

    createStdinStream(
        rsSource: ReadableStream<string> | ReadableStream<Uint8Array>,
        kindSource: StreamDataType,
        isTTY?: boolean
    ):IStdinStream;
    
    createStdoutStream(
        wsDest: WritableStream<string> | WritableStream<Uint8Array>,
        kindDest: StreamDataType,
        isTTY?: boolean
    ): IStdoutStream;

    addCleanupHook(fn: () => void): void;

    /**
     * [New] Register resources (file streams, etc.) owned by this process
     * Registered resources are automatically closed during exit.
     */
    addResource(res: IResource): void;
}

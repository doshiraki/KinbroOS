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
 * 標準入出力ストリームや環境変数へのアクセスを提供する。
 */

import { IEnvManager } from "./IEnvManager";
import { IFileSystem } from "./IFileSystem";

/**
 * ストリームの中身（SourceKind）を定義するEnum
 * メモリ効率と高速化のため数値で管理。
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
    EMBRYO,       // 生成中（PID/PGID確定待ち）
    RUNNING,      // 実行中
    SUSPENDED,    // サスペンド（親が子を待っている状態など）
    ZOMBIE,       // 終了したが、親に看取られていない状態
    TERMINATED    // 完全に消滅
}

// 🌟 1. 追加: シグナル終了を表すエラークラス
export class SignalError extends Error {
    constructor(public signal: number) {
        super(`Signal: ${signal}`);
    }
}

/**
 * 入力ストリームの抽象インターフェース
 * 実装クラス(StdinStream)への依存を断ち切るために使用。
 */
export interface IStdinStream {
    /** TTY（端末）に接続されているか？ */
    readonly isTTY: boolean;
    
    /** ✨ Update: 文字列ではなく Enum を受け取る */
    setMode(mode: TTYMode): Promise<void>;

    // ✨ 追加: 読み込みを強制中断する
    interrupt(reason?: any): Promise<void>;

    /**
     * バイト列として読み込むためのReaderを取得する
     * (ロック状態ならエラー)
     */
    getByteReader(): ReadableStreamDefaultReader<Uint8Array>;

    /**
     * 文字列として読み込むためのReaderを取得する
     * (ロック状態ならエラー)
     */
    getStringReader(): ReadableStreamDefaultReader<string>;
}

/**
 * 出力ストリームの抽象インターフェース
 */
export interface IStdoutStream {
    readonly isTTY: boolean;

    // ✨ 追加: 読み込みを強制中断する
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
    /** プロセスID (PID) */
    readonly pid: number;

    readonly state: ProcessState;
    setState(state: ProcessState):void;

    /** プロセスグループID (PGID) */
    readonly pgid: number;

    /** 環境変数のコピー (ReadOnly) */
    readonly env: IEnvManager;
    
    /** ファイルシステム (ReadOnly) */
    readonly fs: IFileSystem;
    
    // --- Web Streams API Standard ---
    
    /** 標準入力 (Stdin) */
    readonly stdin?: IStdinStream;

    /** 標準出力 (Stdout) */
    readonly stdout?: IStdoutStream;

    /** 標準エラー出力 (Stderr) */
    readonly stderr?: IStdoutStream;

    wait(): Promise<number>;

    /**
     * プロセスを終了する
     * @param code 終了コード (0: 正常, >0: エラー)
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

}

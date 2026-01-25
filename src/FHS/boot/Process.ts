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
 * [Class: Process]
 * 実行中のプログラムの状態（I/O と Lifecycle）を管理するコンテナ。
 * Promise制御（wait/kill）と Web Streams（stdin/out/err）を統合する。
 */
import { IEnvManager } from '@/dev/types/IEnvManager';
import { SignalError } from '../../dev/types/IProcess';
import type { IProcess, IStdinStream, IStdoutStream, StreamDataType} from '../../dev/types/IProcess';
import { ProcessState } from '../../dev/types/IProcess';
import { StdinStream, StdoutStream } from './StdIO';
import { FileSystemManager } from './FileSystem';
import { IFileSystem } from '@/dev/types/IFileSystem';



export class Process implements IProcess {
    // --- 1. Identity & Context ---
    public readonly parent: IProcess | null;
    state: ProcessState = ProcessState.EMBRYO;
    public setState(state: ProcessState): void {
        this.state = state;
    }

    public readonly pid: number;
    public readonly pgid: number;
    public readonly name: string;
    public readonly env: IEnvManager;
    public readonly fs: IFileSystem;

    // --- 2. I/O Streams (Web Standards) ---
    public readonly stdin?: IStdinStream;
    public readonly stdout?: IStdoutStream;
    public readonly stderr?: IStdoutStream;

    // --- 3. Lifecycle Management (Promise Control) ---
    // プロセスの終了を待機するためのPromise
    private readonly promCompletion: Promise<number>;
    
    // 外部からPromiseを完了させるためのトリガー (Deferred Pattern)
    // Application Hungarian: 'fn' (Function)
    private fnResolve!: (code: number) => void;
    private fnReject!: (reason: any) => void;

    // 🌟 1. 後片付けリスト
    private readonly listCleanupHooks: (() => void)[] = [];

    /**
     * @param streams 親から継承、または新規作成されたストリーム
     */
    constructor(
        parentProc: IProcess|null,
        pid: number,
        name: string,
        env: IEnvManager,
        streams?:{ 
            stdin?: IStdinStream, 
            stdout?: IStdoutStream,
            stderr?: IStdoutStream
        },
        options?: { pgid?: number, newGroup?: boolean }
    ) {
        this.parent = parentProc;
        this.pid = pid;
        this.name = name;
        this.env = env;
        this.fs = new FileSystemManager(env);
        // --- PGID 決定ロジック ---
        if (options?.newGroup) {
            // 「新しい党を立ち上げる！」（自分がリーダー）
            this.pgid = pid;
        } else if (options?.pgid !== undefined) {
            // 「指定された派閥に入ります」
            this.pgid = options.pgid;
        } else if (parentProc) {
            // 「親の七光りです」（親と同じ派閥）
            this.pgid = parentProc.pgid;
        } else {
            // 「私が始祖です」（initプロセスなど）
            this.pgid = pid;
        }
        console.log(`[Process:New] I am '${this.name}' (PID:${this.pid}). My Leader is PGID:${this.pgid}`);
        // I/O のセットアップ
        if (streams) {
            this.stdin = streams.stdin;
            this.stdout = streams.stdout;
            this.stderr = streams.stderr;    
        }

        // Lifecycle Promise の初期化
        // コンストラクタ内で即座に resolve/reject をキャプチャする
        this.promCompletion = new Promise<number>((resolve, reject) => {
            this.fnResolve = resolve;
            this.fnReject = reject;
        });
    }

    /**
         * [New] 終了時に実行したい処理を登録する
         */
    public addCleanupHook(fn: () => void): void {
        this.listCleanupHooks.push(fn);
    }

    /**
     * [Internal] フックの一括実行
     */
    private executeCleanupHooks(): void {
        // 逆順（登録が新しい順）に実行するのが一般的だが、今回は順序問わず
        while (this.listCleanupHooks.length > 0) {
            const fn = this.listCleanupHooks.pop();
            if (fn) {
                try { fn(); } catch (e) { console.warn(`[Process] Cleanup Hook Error:`, e); }
            }
        }
    }
    /**
     * [Lifecycle: Wait]
     * プロセスが終了するまで待機する (親プロセスやカーネルが呼ぶ)
     * @returns 終了コード (Exit Code)
     */
    public async wait(): Promise<number> {
        return this.promCompletion;
    }

    /**
     * [Lifecycle: Exit]
     * プロセスを正常/異常終了させる (プロセス自身やカーネルが呼ぶ)
     * @param code 終了コード (0=Success, >0=Error)
     */
    public exit(code: number): void {
        // すでに終了している場合は何もしない等のガードを入れても良い
        this.executeCleanupHooks(); // 🌟 追加: フック実行
        this.fnResolve(code);
    }

    /**
     * [Lifecycle: Kill]
     * プロセスを強制終了させる (killコマンドなどが呼ぶ)
     * @param signal シグナル番号 (本来は番号だが、JSのエラーとして扱う)
     */
    public kill(signal: number = 9): void {
        // PromiseをRejectさせて、waitしている親に通知する
        this.executeCleanupHooks(); // 🌟 追加: フック実行

        // 🌟 I/O待ちで寝ているプロセスを叩き起こす
        const reason = new SignalError(signal);
                
        // stdin/stdout/stderr 全てに中断シグナルを送る
        this.stdin?.interrupt(reason).catch(() => {});
        this.stdout?.interrupt(reason).catch(() => {});
        this.stderr?.interrupt(reason).catch(() => {});

        // 🌟 2. 変更: 一般的なErrorではなくSignalErrorでRejectする
        this.fnResolve(128 + signal);
    }

    public createStdinStream(rsSource: ReadableStream<string> | ReadableStream<Uint8Array>, kindSource: StreamDataType, isTTY: boolean = false ): IStdinStream {
        return new StdinStream(rsSource, kindSource, isTTY);
    }

    public createStdoutStream(wsDest: WritableStream<string> | WritableStream<Uint8Array>, kindDest: StreamDataType): IStdoutStream {
        return new StdoutStream(wsDest, kindDest);
    }
}
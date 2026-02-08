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
import { SignalError, IResource } from '../../dev/types/IProcess';
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

    // 🌟 2. 閉店作業リスト (同期フック + 非同期リソース)
    private readonly listCleanupHooks: (() => void)[] = [];
    private readonly listResources: IResource[] = [];

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
     * [New] このプロセスが所有するリソース（ファイルストリーム等）を登録する
     * ここに登録されたものは、exit時に自動的に close() が待機される。
     */
    public addResource(res: IResource): void {
        this.listResources.push(res);
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
     * [Internal] リソースの解放とFlush待ち (非同期)
     */
    private async cleanupAsync(): Promise<void> {

        // 同期フックを先に実行
        this.executeCleanupHooks();

        // 登録されたリソースを全て閉じる (順次実行で安全に)
        // これにより FileStream.close() -> flush() が完了するまで待機が発生する
        for (const res of this.listResources) {
            try {
                await res.close();
            } catch (e) {
                console.warn(`[Process] Resource close error (PID:${this.pid}):`, e);
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
        if (this.state === ProcessState.TERMINATED) return;
        
        // まずステータスを変える（二重終了防止）
        this.state = ProcessState.TERMINATED;

        // 🌟 3. 非同期クリーンアップの実行
        // (Fire-and-forgetではなく、Promiseチェーンの中で解決する)
        this.cleanupAsync().then(() => {
            // 全てのFlushが終わって初めて、親プロセス(waitしてる人)に通知が行く
            this.fnResolve(code);
        }).catch((err) => {
            console.error(`[Process] Cleanup failed for PID:${this.pid}`, err);
            // 失敗しても親を待たせ続けるわけにはいかないので解決する
            this.fnResolve(code);
        });
    }

    /**
     * [Lifecycle: Kill]
     * プロセスを強制終了させる (killコマンドなどが呼ぶ)
     * @param signal シグナル番号 (本来は番号だが、JSのエラーとして扱う)
     */
    public kill(signal: number = 9): void {
        // 強制終了時でも、可能な限りリソース解放を試みる
        // ただし kill は即時性が求められるため、await せずにバックグラウンドで走らせる手もあるが
        // ここでは安全側に倒して cleanupAsync を呼んでから resolve する (exitと同じフロー)
        
        if (this.state === ProcessState.TERMINATED) return;
        this.state = ProcessState.TERMINATED;

        // I/O待ちで寝ているプロセスを叩き起こす
        const reason = new SignalError(signal);
        this.stdin?.interrupt(reason).catch(() => {});
        this.stdout?.interrupt(reason).catch(() => {});
        this.stderr?.interrupt(reason).catch(() => {});

        this.cleanupAsync().then(() => {
             // 🌟 2. 変更: 一般的なErrorではなくSignalErrorでRejectする
            this.fnResolve(128 + signal);
        }).catch(() => {
            this.fnResolve(128 + signal);
        });
    }

    public createStdinStream(rsSource: ReadableStream<string> | ReadableStream<Uint8Array>, kindSource: StreamDataType, isTTY: boolean = false ): IStdinStream {
        return new StdinStream(rsSource, kindSource, isTTY);
    }

    public createStdoutStream(wsDest: WritableStream<string> | WritableStream<Uint8Array>, kindDest: StreamDataType): IStdoutStream {
        return new StdoutStream(wsDest, kindDest);
    }
}
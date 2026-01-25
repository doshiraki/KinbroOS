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

import { IProcess } from './IProcess';
import { IStdinStream, IStdoutStream, TTYMode } from './IProcess';
import { IArchiver } from './IArchiver'; // 追加
/**
 * [System API Facade]
 * ユーザーランドの main 関数に注入(Inject)されるシステムオブジェクトの定義。
 * 個別のインターフェースを集約し、OS機能への統一的なアクセスポイントを提供する。
 */
export interface SystemAPI {
    createSession(sessionPid: number, stdin: IStdinStream, stdout: IStdoutStream): void;

    signalForeground(sessionPid: number, signal: number):void;

    // ✨ Update: Enum Use
    setTTYMode(sessionPid: number, mode: TTYMode): void;

    /**
     * [New] プロセスを起動し、そのハンドラを即座に返す (待機しない)
     */
    startProcess(
        parentProc: IProcess,
        strPathExecCandidate: string, 
        arrArgs: string[],
        isToCopyEnv: boolean,
        ioRedirect?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): Promise<IProcess>;

    /** * 初期環境変数 (Read/Write可能だがプロセス内スコープ)
     * プロセス起動時の環境変数のスナップショット。
     */
    execPath(
        parentProc: IProcess,
        strPathExecCandidate: string,
        arrArgs: string[],
        isToCopyEnv: boolean,
        ioRedirect?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): Promise<number>;

    spawn(
        parentProc: IProcess,
        strName: string,
        fnTask: (proc: IProcess) => Promise<number>,
        isToCopyEnv: boolean,
        ioConfig?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): IProcess;
    
    createArchiver(proc: IProcess): IArchiver; // ファクトリーメソッド追加 [cite: 1079, 1080]

    setForegroundPgid(sessionPid: number, pgid: number): void;

}

// 🌟 型定義: 仮想バイナリのメイン関数シグネチャ
export type VirtualBinaryMain = (args: string[], sys: SystemAPI, proc: IProcess) => Promise<number>;

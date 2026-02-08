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

import { EnvManager } from './EnvManager';
import { Process } from './Process';
import { IProcess, IStdinStream, IStdoutStream, TTYMode, ProcessState, StreamData} from '../../dev/types/IProcess'
import { SystemAPI} from '../../dev/types/SystemAPI'
import { IFileSystem } from '@/dev/types/IFileSystem';
import { Archiver } from './Archiver';
import { IArchiver } from '../../dev/types/IArchiver';
import { TTYDriver } from './TTYDriver'; // Import!
import { StdinStream, StdoutStream } from './StdIO';
import { LinkerDetective} from './LinkerDetective';

export class KinbroKernel implements SystemAPI{
    private cntNextPid: number = 1;
    private readonly mapProcessTable: Map<number, Process> = new Map();

    // 🌟 Router: グローバルFSマップと連携
    private routerUrl: string | null = null;
    private readonly mapBlobs: Record<string, string> = {}; // Path -> BlobURL

    private readonly mapSessions: Map<number, TTYDriver> = new Map();
    constructor() {

        // コンストラクタでRouter起動
        LinkerDetective.init();
    }

    
    // ✨ Update Method
    public setTTYMode(sessionPid: number, mode: TTYMode): void {
        const tty = this.mapSessions.get(sessionPid);
        if (tty) tty.setMode(mode);
    }


    /**
     * [Updated] セッション作成
     * IStdinStream / IStdoutStream を受け取り、それをアダプター経由で TTY に接続する
     */
    public createSession(sessionPid: number, stdin: IStdinStream, stdout: IStdoutStream): void {
        const tty = new TTYDriver(sessionPid, sessionPid);
        tty.onSignal = (targetPgid, signal) => {
            this.signalForeground(sessionPid, signal);
        };

        // 🌟 IStream -> ReadableStream/WritableStream Adapter
        // TTYDriver は生の Stream を欲しがるので、IStream からデータを吸い出して渡す
        
        const rsPhysicalIn = new ReadableStream({
            async pull(controller) {
                try {
                    // IStdinStream から読み取って TTY に流す
                    const reader = stdin.getByteReader();
                    const { value, done } = await reader.read();
                    if (done) controller.close();
                    else controller.enqueue(value);
                    reader.releaseLock();
                } catch (e) { controller.error(e); }
            }
        });

        const wsPhysicalOut = new WritableStream({
            async write(chunk) {
                // TTY からの出力 (Echo等) を IStdoutStream に流す
                const writer = stdout.getByteWriter();
                await writer.write(chunk);
                writer.releaseLock();
            }
        });

        tty.attachPhysicalIO(rsPhysicalIn, wsPhysicalOut);
        this.mapSessions.set(sessionPid, tty);        
        console.log(`[Kernel] Session ${sessionPid} created with Physical I/O.`);
    }

    // --- Job Control API ---
    
    // カーネルへの問い合わせも一本化されたマップを見るだけ
    public getForegroundPgid(sessionPid: number): number | null {
        return this.mapSessions.get(sessionPid)?.pgidForeground ?? null;
    }

    public setForegroundPgid(sessionPid: number, pgid: number): void {
        const tty = this.mapSessions.get(sessionPid);
        if (!tty) return;

        tty.pgidForeground = pgid; // TTYのターゲットを切り替え

        // ✨ モダンUNIXの客観的制御
        const shellProc = this.mapProcessTable.get(sessionPid);
        if (shellProc) {
            if (pgid !== sessionPid) {
                shellProc.setState(ProcessState.SUSPENDED); // 子がFGなら親はサスペンド
                console.log(`[Kernel] Shell(${sessionPid}) is now SUSPENDED.`);
            } else {
                shellProc.setState(ProcessState.RUNNING); // 権限が戻れば親は実行中に
                console.log(`[Kernel] Shell(${sessionPid}) is now RUNNING.`);
            }
        }
    }

    // 「このシェル(sessionPid)から Ctrl+C が来たぞ！ そこの主役を殺せ！」
    public signalForeground(sessionPid: number, signal: number = 9) {
        const { pgidForeground: targetPgid } = this.mapSessions.get(sessionPid)!;
        
        if (!targetPgid) return; // 主役不在なら何もしない
        
        console.log(`[Kernel] ⚡ Signal(${signal}) -> Session:${sessionPid} / Target PGID:${targetPgid}`);
        
        // 🌟 SIGTSTP (Ctrl+Z) の場合
        if (signal === 20) {
            // 対象PGIDの全プロセスを探してサスペンド通知
            for (const proc of this.mapProcessTable.values()) {
                if (proc.pgid === targetPgid) {
                    // プロセス自体に「止まれ」と伝えるメソッドが必要だが、
                    // 今回は簡易的に「Kernelが勝手にwaitを解く」アプローチを取る。
                    
                    // ※ Process型にモンキーパッチされた suspend() を呼ぶ想定
                    if ((proc as any).suspend) {
                        (proc as any).suspend();
                    }
                }
            }
            return;
        }
        // 全プロセス走査
        for (const proc of this.mapProcessTable.values()) {
            if (proc.pgid === targetPgid) {
                try {
                     proc.kill(signal);
                } catch(e) {}
            }
        }
    }

    createInitProcess() :IProcess{
        const env = new EnvManager({}, true);
        env.set('PATH', '/usr/bin');
        env.set('HOME', '/home/geek');
        env.set('USER', 'geek');
        return new Process(null, this.cntNextPid++, "init", env);
    }
    /**
     * [Boot Sequence]
     * BIOSから渡されたハンドル情報を使ってシステムを起動する。
     * @param handles BIOSが用意したファイルシステムハンドル
     */
    public async boot(proc: IProcess,handles: { root: FileSystemDirectoryHandle, boot?: FileSystemDirectoryHandle }): Promise<void> {
        console.log('[Kernel] Booting with injected VFS handles...');
        
        // ハンドルを使ってマウント実行 (具体的なパスはKernelは知らなくていい)
        await proc.fs.mount(handles.root, handles.boot);
        
        console.log('[Kernel] FileSystem mounted.');
    }

    /**
     * [New Helper] 指定されたパスに実行可能ファイルがあるか、拡張子を変えて確認する
     * @param fs ファイルシステム
     * @param strPathBase 拡張子なし(かもしれない)パス
     * @returns 発見された完全パス (なければ null)
     */
    private async findExecutable(fs: IFileSystem, strPathBase: string): Promise<string | null> {
        // ここで探索する拡張子を定義。優先順位順。
        const arrExtensions = ["", ".js"]; 
        
        for (const ext of arrExtensions) {
            const strTrial = strPathBase + ext;
            if (await fs.exists(strTrial)) {
                return strTrial; // 見つけた！
            }
        }
        return null;
    }

    /**
     * [API] 非同期プロセス起動 (IProcessを即座に返す)
     */
    public async startProcess(
        parentProc: IProcess,
        strPathExecCandidate: string, 
        arrArgs: string[],
        isToCopyEnv: boolean = true,
        ioRedirect?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): Promise<IProcess> {

        // 1. パス解決 (前回と同じ)
        let strPathExec: string | null = null;
        if (strPathExecCandidate.includes('/')) {
            const absCandidate = parentProc.fs.resolvePath(strPathExecCandidate);
            strPathExec = await this.findExecutable(parentProc.fs, absCandidate);
        } else {
            const strPathEnv = parentProc.env.get('PATH') || '/usr/bin:/bin';
            for (const strDir of strPathEnv.split(':')) {
                const base = strDir.endsWith('/') ? strDir.slice(0, -1) : strDir;
                const found = await this.findExecutable(parentProc.fs, `${base}/${strPathExecCandidate}`);
                if (found) { strPathExec = found; break; }
            }
        }

        if (!strPathExec) throw new Error(`Kernel: Command not found: ${strPathExecCandidate}`);

        // 2. モジュールロード (依存関係解決)
        const loadInfo = await this.importWithDependencies(parentProc, strPathExec);
        
        if (typeof loadInfo.module.main !== 'function') {
            LinkerDetective.removeReferences(loadInfo.imports);
            throw new Error(`Kernel: ${strPathExec} has no exported 'main' function.`);
        }

        // 3. Spawn (シンプル！)
        const proc = this.spawn(
            parentProc,
            strPathExec, 
            async (p) => {
                // ここで try-finally しなくても良くなる！
                // 純粋に main を実行するだけ
                return await loadInfo.module.main(arrArgs, this, p);
            },
            isToCopyEnv,
            ioRedirect,
            options
        );

        // 🌟 4. リソース解放を「予約」する
        // プロセスが exit/kill されたら自動的に参照カウントを減らす
        proc.addCleanupHook(() => {
            console.log(`[Kernel] Releasing resources for process ${proc.pid}`);
            LinkerDetective.removeReferences(loadInfo.imports);
        });

        return proc;
    }

    public async execPath(
        parentProc: IProcess,
        strPathExecCandidate: string, 
        arrArgs: string[],
        isToCopyEnv: boolean = true,
        ioRedirect?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): Promise<number> {

        // startProcess に委譲して待つだけ
        const proc = await this.startProcess(parentProc, strPathExecCandidate, arrArgs, isToCopyEnv, ioRedirect, options);
        return await proc.wait();
    }

    /**
     * [Logic: Import With Dependencies]
     * ソースコードを再帰的に走査し、依存関係を全てBlob化してImportMapで解決させる。
     * @param pathEntry エントリーポイントのファイルパス (絶対パス)
     */
    private async importWithDependencies(parentProc: IProcess, pathEntry: string): Promise<{ "module": any, "imports": Set<string>}> {
        console.log(`[Kernel] Dynamic Import: Resolving dependencies for ${pathEntry}...`);
        const setProcesses = await LinkerDetective.sourceTransform(parentProc.fs, pathEntry);

        // 3. エントリーポイントをインポート
        console.log(pathEntry);
        const module = await import(/* @vite-ignore */LinkerDetective.getBlobUrl(pathEntry)!);
        return {module: module, imports: setProcesses};
    }

    public spawn(
        parentProc: IProcess,
        strName: string,
        fnTask: (proc: IProcess) => Promise<number>,
        isToCopyEnv: boolean = true,
        ioConfig?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): IProcess {
        const pid = this.cntNextPid++;
        
        let targetPgid = pid;
        if (options?.newGroup) targetPgid = pid;
        else if (options?.pgid !== undefined) targetPgid = options.pgid;
        else if (parentProc) targetPgid = parentProc.pgid;

        let sessionPid = 0;
        
        // I/Oの準備
        let streamIn = ioConfig?.stdin;
        let streamOut = ioConfig?.stdout;
        const streamErr = ioConfig?.stderr; // stderrは別ストリームなので共有不要

        // 🌟 修正: newSession ブロックを統合し、Shared Writer パターンを適用
        if (options?.newSession) {
            sessionPid = pid;
            const physicalOut = ioConfig?.stdout; // 物理画面出力

            if (ioConfig?.stdin && physicalOut) {
                // ✨ 1. 物理出力を「永続的」にロックする (Shared Writer)
                // getByteWriter() を一度だけ呼び、その writer インスタンスを TTY とプロセスで使い回す。
                // これにより getWriter() の競合エラー(Locked)を物理的に回避する。
                const sharedWriter = physicalOut.getByteWriter();

                // 🔌 2. TTY用ブリッジ (Echo用)
                const wsForTTY = new WritableStream({
                    async write(chunk) {
                        // 確保済みの writer に書き込む (並列呼び出しも安全にキューイングされる)
                        await sharedWriter.write(chunk);
                    },
                    close() { /* sharedWriterは閉じない (プロセスが生きているかもしれない) */ }
                });

                // 🔌 3. プロセス用ブリッジ (Shell出力用)
                const wsForProcess = new WritableStream({
                    async write(chunk) {
                        await sharedWriter.write(chunk);
                    },
                    close() { /* sharedWriterは閉じない (kibtermが閉じるまで維持) */ }
                });

                // 4. セッション作成 (TTYには専用ブリッジを渡す)
                this.createSession(sessionPid, ioConfig.stdin, new StdoutStream(wsForTTY, StreamData.Uint8Array));
                
                // 5. プロセス用ストリームを更新 (共有ブリッジを渡す)
                streamOut = new StdoutStream(wsForProcess, StreamData.Uint8Array);
            }

        } else if (parentProc) {
            sessionPid = Number(parentProc.env.get('SESSION_PID') || 0);
            if (sessionPid === 0 && this.mapSessions.has(parentProc.pid)) {
                sessionPid = parentProc.pid;
            }
        } else {
            sessionPid = pid; 
        }

        const tty = this.mapSessions.get(sessionPid);
        
        // 🌟 3. Input Hijack (入力の競合回避)
        if (tty && (options?.newSession || !streamIn)) {
            const rsTTY = tty.createStreamFor(targetPgid);
            
            streamIn = new StdinStream(
                rsTTY, 
                StdinStream.STRING, 
                true,
                async (mode: TTYMode) => { tty.setMode(mode); }
            );
            
            // ioConfig を更新
            if (ioConfig) {
                ioConfig.stdin = streamIn;
                ioConfig.stdout = streamOut; 
            }
        }

        options = { ...options, pgid: targetPgid };

        console.log(`[Kernel:spawn] PID:${pid} CMD:${strName} PGID:${targetPgid} (Session:${sessionPid})`);
        
        const proc = new Process(
            parentProc,
            pid,
            strName,
            isToCopyEnv ? parentProc.env.clone() : parentProc.env,
            { stdin: streamIn as IStdinStream, stdout: streamOut as IStdoutStream, stderr: streamErr as IStdoutStream },
            options
        );
        
        if (sessionPid > 0) proc.env.set('SESSION_PID', String(sessionPid));
        if (options?.newGroup) this.setForegroundPgid(sessionPid, proc.pgid);

        this.mapProcessTable.set(pid, proc);
        setTimeout(async () => {
            try {
                proc.setState(ProcessState.RUNNING);
                const codeExit = await fnTask(proc);
                this.exitProcess(pid, codeExit);
            } catch (err: any) {
                try {
                    const writer = proc.stderr?.getStringWriter();
                    if (writer) {
                        // メッセージ末尾の改行など
                        await writer.write(`\nKernel Panic (Process ${pid}): ${err.message || err}\n`).catch(() => {});
                        writer.releaseLock();
                    }
                } catch (e) {
                    console.error(`[Kernel] Failed to write panic to stderr for PID:${pid}`, e);
                }
                this.exitProcess(pid, 1);
            }
        }, 0);
        
        return proc;
    }

    private exitProcess(pid: number, code: number): void {
        const proc = this.mapProcessTable.get(pid);
        if (!proc) return;
        // 🌟 お掃除ロジックを追加
        // ✨ [Phase 3: 終焉] 削除前に TERMINATED を確定
        proc.exit(code);
                
        const sessionPid = Number(proc.env.get('SESSION_PID') || 0);
        const tty = this.mapSessions.get(sessionPid);
        if (tty) {
            // このプロセスのグループ ID を TTY から登録解除する
            tty.cleanup(proc.pgid);
            console.log(`[Kernel] TTY Cleanup for PGID: ${proc.pgid}`);
        }

        // 3. ✨ オートリターン判定
        // 自身が属していたグループに、もう生きているプロセスがいないか確認
        const remaining = this.getProcessesInGroup(proc.pgid);
        if (remaining.length === 0) {
            console.log(`[Kernel] Group ${proc.pgid} has terminated.`);
            
            // もしこのグループがフォアグラウンドだったなら、シェルに権限を戻す
            if (this.getForegroundPgid(sessionPid) === proc.pgid) {
                console.log(`[Kernel] Auto-returning foreground to Shell(${sessionPid})`);
                this.setForegroundPgid(sessionPid, sessionPid);
            }
        }

        this.mapProcessTable.delete(pid);
        console.log(`[Kernel:Exit] PID:${pid} (${proc.name}) Code:${code} PGID:${proc.pgid}`);    }

    public panic(err: Error): void {
        console.error('🔥 KERNEL PANIC 🔥');
        console.error(err);
    }
    public createArchiver(proc: IProcess): IArchiver {
        return new Archiver(proc.fs); // プロセスのFSコンテキストを渡して生成 [cite: 385, 526]
    }

    /**
     * 指定したPGIDに属する「生きている」プロセスをすべて取得
     */
    public getProcessesInGroup(pgid: number): Process[] {
        return Array.from(this.mapProcessTable.values())
            .filter(p => p.pgid === pgid && p.state !== ProcessState.TERMINATED);
    }


}
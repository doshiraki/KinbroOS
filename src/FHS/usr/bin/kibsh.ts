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

import parse from 'bash-parser';
import { CommandParser } from '../lib/CommandParser';
import { ZenTransfer } from '../lib/ZenTransfer';
import { SystemAPI, VirtualBinaryMain } from '@/dev/types/SystemAPI';
import { IShell } from '@/dev/types/IShell';
import { ReadLine, Completer, ReadLineResult } from '../lib/ReadLine';
import { createFileSinkStream } from '../lib/FileStreamAdapter';
import { IProcess, StreamData, IStdinStream, TTYMode, ProcessState, SignalError } from "../../../dev/types/IProcess";
import { BinaryReader, BinaryWriter, IBinaryReader, IBinaryWriter } from '../lib/StreamUtils';

/**
 * [New] シェルを終了させるための制御用例外
 * プロセスを即死させるのではなく、ループを抜けて正常終了させるために使う
 */
class ShellExitError extends Error {
    constructor(public code: number) {
        super(`Shell exit with code ${code}`);
    }
}

export class Kibsh implements IShell {
    private objKernel: SystemAPI;
    public readonly proc: IProcess;
    private arrDirStack: string[] = [];
    private objTransfer: ZenTransfer;
    
    // index 0 が常に「大元の入力 (TTY/Root)」、末尾が「現在の入力」
    private stackReaders: IBinaryReader[] = [];
    // 🌟 追加: バッチモード（非対話）フラグ
    private isInteractive: boolean;

    // 🌟 1. State Mutators: シェル自身の状態を変えるため、プロセス化できないコマンド
    private readonly mapShellMutators: Record<string, (args: string[], writer: IBinaryWriter) => Promise<number>> = {
        'cd': this.cmdCd.bind(this),
        'pushd': this.cmdPushd.bind(this),
        'popd': this.cmdPopd.bind(this),
        'dirs': this.cmdDirs.bind(this),
        'export': this.cmdExport.bind(this),
        'exit': async (_a, w) => { throw new ShellExitError(0); }
    };

    // 🌟 2. Virtual Binaries: プロセスとして実行可能な内部コマンド
    private readonly mapVirtualBinaries: Record<string, VirtualBinaryMain> = {
        'touch': this.cmdTouch.bind(this),
        'pwd': this.cmdPwd.bind(this),
        'env': this.cmdEnv.bind(this), // envもプロセス化（自分の環境変数を表示）
        'echo': this.cmdEcho.bind(this),
        'whoami': async (_a, _s, proc) => { 
             const w = proc.stdout?.getStringWriter(); 
             if(w) { await w.write('geek\r\n'); await w.close(); } 
             return 0; 
        },
        'zenput': this.cmdZenPut.bind(this),
        'zenget': this.cmdZenGet.bind(this),
    };

    // 補完用リスト
    private get arrSupportedCommands(): string[] {
        return [
            ...Object.keys(this.mapShellMutators),
            ...Object.keys(this.mapVirtualBinaries)
        ];
    }

    constructor(objKernel: SystemAPI, proc: IProcess) {
        this.objKernel = objKernel;
        this.proc = proc;
        this.objTransfer = new ZenTransfer(proc.fs);
        // 🌟 TTY判定: 標準入力がTTYなら対話モード
        this.isInteractive = proc.stdin?.isTTY ?? false;

        try { parse('true'); } catch (e) { console.warn('[Kibsh] Parser warm-up warning:', e); }
        
        // 対話モードの時だけ、自分をフォアグラウンドに設定する
        if (this.isInteractive) {
            this.objKernel.setForegroundPgid(this.proc.pid, this.proc.pgid);
        }
    }

    /**
     * [Logic] コマンドライン全体の実行
     */
    public async executeLogic(strInput: string, reader: IBinaryReader, writer: IBinaryWriter): Promise<number> {
        if (!strInput.trim()) return 0;
        this.stackReaders.push(reader);
        try {
            const objAst = parse(strInput);
            let valLastExitCode = 0;

            if (objAst.type === 'Script' && objAst.commands) {
                for (const objNode of objAst.commands) {
                    // evalNode はプロセスを返すかもしれない
                    const result = await this.evalNode(objNode, reader, writer);
                    if (typeof result === 'number') {
                        // 組み込みコマンド (cd等) はそのまま終了コード
                        valLastExitCode = result;
                    } else {
                        await result.wait();
                        
                        // 念のため、自分がサスペンドされていたら自力で起きる
                        if (this.isInteractive && this.proc.state === ProcessState.SUSPENDED) {
                            this.proc.setState(ProcessState.RUNNING);
                        }

                        valLastExitCode = 0;
                    }
                }
            }
            return valLastExitCode;
        } catch (objErr: any) {
            // ✨ Exitシグナルならそのまま上位へ投げる（ここでは握りつぶさない）
            // これにより、パイプラインやスクリプト実行中でも即座に中断できる
            if (objErr instanceof ShellExitError) {
                throw objErr;
            }
            // 🌟 2. 追加: Ctrl+C (SignalError) ならエラー表示せずに終了
            if (objErr instanceof SignalError) {
                // UNIXの慣例: シグナル終了のコードは 128 + シグナル番号 (SIGINT=2なら130)
                return 128 + objErr.signal; 
            }
            console.error(objErr);
            await writer.writeString(`kibsh: parse error: ${objErr.message}\r\n`);
            return 2;
        } finally {
            this.stackReaders.pop();
        }
    }

    /**
     * [Evaluator] ASTノードの種類に応じたディスパッチ
     * options引数を追加してPGID情報を伝播
     */
    private async evalNode(objNode: any, reader: IBinaryReader, writer: IBinaryWriter, options?: { pgid?: number, newGroup?: boolean }): Promise<IProcess | number> {
        switch (objNode.type) {
            case 'Pipeline':
                return await this.executePipeline(objNode, reader, writer);
            case 'Command':
                return await this.executeCommand(objNode, reader, writer, options);
            case 'LogicalExpression':
                // 左側のコマンドを実行
                const leftResult = await this.evalNode(objNode.left, reader, writer, options);
                // 終了コードを取得 (プロセスの場合は wait() する)
                const leftExitCode = (typeof leftResult === 'number') ? leftResult : await leftResult.wait();
            
                if (objNode.op === 'and') {
                    // && の場合: 左が成功(0)なら右を実行
                    if (leftExitCode === 0) return await this.evalNode(objNode.right, reader, writer, options);
                    return leftExitCode;
                } else {
                    // || の場合: 左が失敗(0以外)なら右を実行
                    if (leftExitCode !== 0) return await this.evalNode(objNode.right, reader, writer, options);
                    return leftExitCode;
                }
            default:
                await writer.writeString(`kibsh: unsupported node type: ${objNode.type}\r\n`);
                return 1;
        }
    }

    /**
     * [Helper] 実行パラメータの準備
     */
    private async prepareExecution(objNode: any, writer: IBinaryWriter): Promise<{
        cmd: string, 
        args: string[], 
        destWriter: IBinaryWriter, 
        cleanupAction: (()=>Promise<void>)|null 
        isRedirect: boolean // 🌟 追加
    } | null> {
        
        const arrRedirects = this.extractRedirections(objNode);
        const arrRawArgs = this.expandArgs(objNode);
        
        if (arrRawArgs.length === 0 && arrRedirects.length === 0) return null;

        let strCmd = "";
        let arrArgs: string[] = [];
        if (arrRawArgs.length > 0) {
            strCmd = arrRawArgs[0];
            arrArgs = arrRawArgs.slice(1);
            try {
                const resolved = await this.resolveCommandName(strCmd, arrArgs);
                strCmd = resolved.command;
                arrArgs = resolved.args;
            } catch (e) {}
        }

        let destWriter: IBinaryWriter; 
        let cleanupAction: (() => Promise<void>) | null = null;
        let isRedirect = false; // 🌟 初期値

        if (arrRedirects.length > 0) {
            isRedirect = true; // 🌟 リダイレクトあり
            try {
                const res = await this.setupRedirection(arrRedirects);
                destWriter = new BinaryWriter(res.stream.getWriter());
                cleanupAction = async () => { try { await destWriter.close(); } catch {} };
            } catch (e: any) {
                throw new Error(`redirection error: ${e.message}`);
            }
        } else {
            destWriter = writer;
        }

        return { cmd: strCmd, args: arrArgs, destWriter, cleanupAction, isRedirect };
    }

    /**
     * [Pipeline] Parallel Execution Logic
     */
    private async executePipeline(objNode: any, originalReader: IBinaryReader, originalWriter: IBinaryWriter): Promise<number> {
        const arrCommands = objNode.commands;
        let currentReader = originalReader; 
        let pipelinePgid: number | undefined;
        const processes: IProcess[] = [];

        // 🌟 プロセス起動直前に Cooked にする
        if (this.isInteractive && this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Cooked);
        }
        
        for (let i = 0; i < arrCommands.length; i++) {
            const cmdNode = arrCommands[i];
            const isFirst = (i === 0);
            const isLast = (i === arrCommands.length - 1);

            const options = {
                newGroup: this.isInteractive ? isFirst : false,
                pgid: this.isInteractive ? (isFirst ? undefined : pipelinePgid) : this.proc.pgid,
            };


            let nextWriter: IBinaryWriter;
            let nextReaderForLoop: IBinaryReader | null = null;

            if (isLast) {
                nextWriter = originalWriter;
            } else {
                const pipe = new TransformStream<Uint8Array, Uint8Array>();
                nextWriter = new BinaryWriter(pipe.writable.getWriter());
                nextReaderForLoop = new BinaryReader(pipe.readable.getReader());
            }
            
            // 🌟 Parallel Execution
            // 仮想バイナリ化された内部コマンドも、ここで options を受けて並列実行される
            const result = await this.evalNode(cmdNode, currentReader, nextWriter, options);

            if (typeof result !== 'number') {
                processes.push(result);
                if (isFirst && this.isInteractive) {
                    pipelinePgid = result.pid;
                }
            }

            if (nextReaderForLoop) {
                currentReader = nextReaderForLoop;
            }
        }

        if (processes.length > 0) {
            await Promise.all(processes.map(p => p.wait()));
        }

        if (this.isInteractive && this.proc.state === ProcessState.SUSPENDED) {
            this.proc.setState(ProcessState.RUNNING);
        }
        
        if (this.isInteractive && this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Raw);
        }

        return 0;    }

    /**
     * 自分のプロセス状態が RUNNING になるまで待機する
     */
    private async waitSelfRunning(): Promise<void> {

        do {
            // カーネルのオートリターンが発動するまで、イベントループを譲る
            await new Promise(resolve => setTimeout(resolve, 200));
        } while (this.proc.state !== ProcessState.RUNNING);
        if (this.proc.stdin?.isTTY) {
            await this.proc.stdin.setMode(TTYMode.Raw);
        }
    }
    
    private async executeCommand(objNode: any,
        reader: IBinaryReader,
        writer: IBinaryWriter,
        options?: { pgid?: number, newGroup?: boolean}
    ): Promise<IProcess | number> {
        let params;
        try {
            params = await this.prepareExecution(objNode, writer);
        } catch(e: any) {
            await writer.writeString(`kibsh: ${e.message}\r\n`);
            return 1;
        }
        
        if (!params) return 0;

        try {
            if (params.cmd !== "") {
                // 🌟 追加: 単体実行でも Cooked にする
                if (this.isInteractive && this.proc.stdin?.isTTY) {
                    await this.proc.stdin.setMode(TTYMode.Cooked);
                }

                // 🌟 修正: options が渡されていない場合（単体コマンド実行）も考慮
                const effectiveOptions = options || { 
                    newGroup: this.isInteractive, 
                    pgid: this.isInteractive ? undefined : this.proc.pgid 
                };
                
                // dispatchCommand の結果をそのまま返す
                const result = await this.dispatchCommand(params.cmd, params.args, reader, params.destWriter, effectiveOptions);

                // 🌟 修正: リソース管理の委譲 (Process-Centric Cleanup)
                if (typeof result !== 'number') {
                    // 宛先Writerをプロセスに登録し、プロセス終了時に責任を持って閉じさせる。
                    // これにより、リダイレクト(ファイル)もパイプも、Writerがclose(flush)されるまで
                    // 親プロセス(Shell)のwaitが解けないようになる。
                    // ※ TTY(Shield)の場合も登録して問題ない(Shieldのcloseは何もしないため)
                    result.addResource(params.destWriter);

                    // シェル側ではもう管理しない（二重クローズ防止のためnull化）
                    params.cleanupAction = null; 
                }
                return result;
            }
            return 0;
        } finally {
            // 注意: cleanupAction はプロセス起動後すぐに閉じてしまわないよう注意が必要だが、
            // 現状の redirect 実装 (TransformStream等) はプロセス側が握っているので、
            // ここでの close は「シェルの持っているWriter」の放棄という意味で一旦維持する。
            if (params.cleanupAction) await params.cleanupAction();
        }
    }

    /**
     * [Dispatcher] リファクタリング版
     */
    private async dispatchCommand(
        strCmd: string, 
        arrArgs: string[], 
        reader: IBinaryReader, 
        destWriter: IBinaryWriter,
        options?: { pgid?: number, newGroup?: boolean} // 🌟 型追加
    ): Promise<IProcess | number> { // ✨ 戻り値型変更
        console.log(`[Shell:Dispatch] Cmd:${strCmd} NewGroup:${options?.newGroup} RequestedPGID:${options?.pgid}`);
        // A. State Mutators (直列実行・プロセスなし)
        if (this.mapShellMutators[strCmd]) {
            return await this.mapShellMutators[strCmd](arrArgs, destWriter);
        }

        // --- ここから下はすべて「プロセス」として実行される ---
        
        const sessionPid = Number(this.proc.env.get('SESSION_PID') || 0);


        try {
            // I/O Config 構築 (共通ロジック)
            const isRootTTY = (this.stackReaders.length > 0 && reader === this.stackReaders[0]);
            let ioConfigStdin: IStdinStream | undefined;

            if (isRootTTY) {
                ioConfigStdin = undefined; 
            } else {
                const proxyInput = new ReadableStream({
                    async pull(controller) {
                        try {
                            const { value, done } = await reader.read();
                            if (done) controller.close();
                            else controller.enqueue(value);
                        } catch (e) { controller.error(e); }
                    }
                });
                ioConfigStdin = this.proc.createStdinStream(proxyInput, StreamData.Uint8Array);
            }

            // 🌟 Bridge の close ロジック修正
            const createBridgeWithClose = () => new WritableStream<Uint8Array>({
                write(chunk) { return destWriter.write(chunk); },
                close() { 
                    return destWriter.close().catch(()=>{}); 
                }
            });

            const ioConfig = {
                stdin: ioConfigStdin,
                stdout: this.proc.createStdoutStream(createBridgeWithClose(), StreamData.Uint8Array, true),
                stderr: this.proc.createStdoutStream(createBridgeWithClose(), StreamData.Uint8Array, true)
            };

            const kernelOpts = {
                newGroup: options?.newGroup ?? true,
                pgid: options?.pgid
            };

            // 🌟 【ここが修正点】先制サスペンド (Pre-emptive Suspend)
            // 新しいグループ(FG)として実行する場合、カーネルが処理するよりも早く
            // 自分自身を「停止状態」にしておくことで、waitのすり抜けを100%防ぐ。
            if (kernelOpts.newGroup && sessionPid) {
                // IProcessにsetStateがある前提ですが、もしなければキャストしてください
                this.proc.setState(ProcessState.SUSPENDED);
            }
            let proc: IProcess;

            try {

                // B. Virtual Binaries
                if (this.mapVirtualBinaries[strCmd]) {
                    const fnMain = this.mapVirtualBinaries[strCmd];
                    proc = this.objKernel.spawn(
                        this.proc,
                        strCmd,
                        async (p) => await fnMain(arrArgs, this.objKernel, p),
                        true,
                        ioConfig,
                        kernelOpts
                    );
                } else {
                    // C. External Commands
                    // execPath は wait してしまうので、spawn を使う startProcess に切り替えるべきだが、
                    // 今回は Kernel.startProcess が実装済みと仮定して呼ぶ。
                    // まだなら execPath の中身を非同期化したものが必要。
                    proc = await this.objKernel.startProcess(
                        this.proc, strCmd, arrArgs, true, 
                        ioConfig, 
                        kernelOpts
                    );
                }
            } catch (spawnError) {
                // 🌟 失敗時はすぐに RUNNING に戻さないと、シェルが死んだままになる
                if (kernelOpts.newGroup && sessionPid) {
                    if ((this.proc as any).setState) {
                        (this.proc as any).setState(ProcessState.RUNNING);
                    }
                }
                throw spawnError;
            }

            // ✨ IProcess を返して終了
            return proc;

        } catch (e: any) {
             let errorMsg = e.message || e.toString();
             if (errorMsg.includes("Command not found")) errorMsg = `kibsh: ${strCmd}: command not found`;
             else errorMsg = `kibsh: error executing ${strCmd}: ${errorMsg}`;
             await destWriter.writeString(`${errorMsg}\r\n`);
             return 127;
        }
    }

    // --- Virtual Binary Implementations ---

    private async cmdTouch(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
        const writer = proc.stderr!.getStringWriter();
        if (!args[0]) { await writer.write('touch: missing operand\r\n'); await writer.close(); return 1; }
        try { await proc.fs.touchFile(args[0]); } catch (e: any) { await writer.write(`touch: ${e.message}\r\n`); await writer.close(); return 1; }
        await writer.close(); return 0;
    }

    private async cmdPwd(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
        const writer = proc.stdout!.getStringWriter();
        await writer.write(proc.fs.getCWD() + '\r\n');
        await writer.close();
        return 0;
    }

    private async cmdEnv(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
        const writer = proc.stdout!.getStringWriter();
        const env = proc.env as any;
        const list = (typeof env.listAll === 'function') ? env.listAll() : env;
        const strOut = Object.entries(list).map(([k, v]) => `${k}=${v}`).join('\n');
        if (strOut) await writer.write(strOut + '\r\n');
        await writer.close();
        return 0;
    }

    private async cmdEcho(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
        const writer = proc.stdout!.getStringWriter();
        await writer.write(args.map((x)=>x.replace("\r", "\\r").replace("\n","\\n")).join(' ') + '\n');
        await writer.close();
        return 0;
    }

    private async cmdZenPut(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
        const writer = proc.stdout!.getStringWriter();
        const transfer = new ZenTransfer(proc.fs);
        const res = await transfer.put();
        await writer.write(res + '\r\n');
        await writer.close();
        return 0;
    }

    private async cmdZenGet(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
        const writer = proc.stdout!.getStringWriter();
        if (!args[0]) {
            await writer.write('zenget: missing file operand\r\n');
            await writer.close(); return 1;
        }
        const transfer = new ZenTransfer(proc.fs);
        const res = await transfer.get(args[0]);
        await writer.write(res + '\r\n');
        await writer.close();
        return 0;
    }

    // --- State Mutators (Shell Process) ---

    private async cmdCd(args: string[], writer: IBinaryWriter): Promise<number> {
        const parser = new CommandParser(args, { name: 'cd', usage: '[dir]', desc: 'Change directory.' });
        try {
            await this.proc.fs.changeDir(parser.args[0] || '/home');
            return 0;
        } catch (e: any) {
            await writer.writeString(`cd: ${parser.args[0]}: No such file or directory\r\n`);
            return 1;
        }
    }

    private async cmdExport(args: string[], writer: IBinaryWriter): Promise<number> {
        if (args[0] && args[0].includes('=')) {
            const [key, val] = args[0].split('=');
            (this.proc.env as any).set(key, val);
        }
        return 0;
    }
    
    // pushd, popd, dirs は省略するが、同様に this.proc.fs を操作する
    private async cmdPushd(args: string[], writer: IBinaryWriter): Promise<number> { 
        const current = this.proc.fs.getCWD();
        try { await this.proc.fs.changeDir(args[0]); this.arrDirStack.push(current); return await this.cmdDirs(args, writer); } catch(e){ return 1;} 
    }
    private async cmdPopd(args: string[], writer: IBinaryWriter): Promise<number> {
        const path = this.arrDirStack.pop();
        if(path) { await this.proc.fs.changeDir(path); return await this.cmdDirs(args, writer); }
        await writer.writeString('popd: stack empty\r\n'); return 1;
    }
    private async cmdDirs(args: string[], writer: IBinaryWriter): Promise<number> {
        await writer.writeString(`${this.proc.fs.getCWD()} ${[...this.arrDirStack].reverse().join(' ')}\r\n`);
        return 0;
    }

    // --- Helpers ---
    
    private extractRedirections(objNode: any): any[] {
        const arrRedirects: any[] = [];
        if (objNode.prefix) for (const item of objNode.prefix) if (item.type === 'Redirect') arrRedirects.push(item);
        if (objNode.suffix) for (const item of objNode.suffix) if (item.type === 'Redirect') arrRedirects.push(item);
        return arrRedirects;
    }
    
    private expandArgs(objNode: any): string[] {
        const arrResult: string[] = [];
        if (objNode.name && objNode.name.text) arrResult.push(objNode.name.text);
        if (objNode.suffix) {
            for (const s of objNode.suffix) {
                if (s.type !== 'Word') continue;
                let text = s.text || '';
                if (text.startsWith('$')) {
                    const key = text.slice(1);
                    const val = this.proc.env.get(key);
                    text = val !== undefined ? val : '';
                }
                arrResult.push(text);
            }
        }
        return arrResult;
    }

    private async resolveCommandName(strCmd: string, arrArgs: string[]): Promise<{ command: string, args: string[] }> {
        if (!strCmd.includes('/')) return { command: strCmd, args: arrArgs };
        try {
            const stat = await this.proc.fs.getStat(strCmd);
            if (stat.isDirectory()) throw new Error('Is a directory');
            const content = await this.proc.fs.readFile(strCmd, 'utf8') as string;
            if (content.startsWith('#!')) {
                const interpreterName = content.split('\n')[0].substring(2).trim().split('/').pop() || 'js';
                return { command: interpreterName, args: [strCmd, ...arrArgs] };
            }
            return { command: strCmd, args: arrArgs };
        } catch (e) {
            return { command: strCmd, args: arrArgs };
        }
    }

    private async setupRedirection(redirections: any[]): Promise<{ stream: WritableStream<Uint8Array> }> {
        const lastRedirect = redirections[redirections.length - 1];
        const filePath = lastRedirect.file.text;
        const isAppend = (lastRedirect.op && lastRedirect.op.text === '>>');
        const fileHandle = await this.proc.fs.open(filePath, isAppend ? 'a' : 'w');
        return { stream: createFileSinkStream(fileHandle) };
    }

    public async interrupt(): Promise<void> {
        this.objKernel.signalForeground(this.proc.pid, 9);
    }

    public async getCompletions(strPartial: string): Promise<string[]> {
        const fs = this.proc.fs;
        const env = this.proc.env;

        // A. コマンド補完 (パス区切りがない場合のみ)
        // 入力が空、またはパスを含まない場合は、コマンド一覧 + カレントディレクトリのファイル
        if (!strPartial.includes('/')) {
            const pathCWD = fs.getCWD();
            try {
                const arrFiles = await fs.readDir(pathCWD);
                const arrCandidates = [...arrFiles, ...this.arrSupportedCommands];
                
                // 重複排除してフィルタリング
                return Array.from(new Set(arrCandidates))
                    .filter(s => s.startsWith(strPartial))
                    .sort();
            } catch { return []; }
        }

        // B. パス補完 (絶対パス or 相対パス)
        // 例: "/usr/b" -> dir="/usr", base="b"
        // 例: "src/li" -> dir="src", base="li"
        
        // 最後のスラッシュで分割
        const idxLastSlash = strPartial.lastIndexOf('/');
        const strDirPart = strPartial.slice(0, idxLastSlash + 1); // "src/" or "/usr/"
        const strFilePart = strPartial.slice(idxLastSlash + 1);   // "li" or "b"

        try {
            // ディレクトリの中身を読み取る
            // (resolvePath は相対パスも絶対パスも解決してくれる)
            const pathResolved = fs.resolvePath(strDirPart);
            
            // ディレクトリか確認
            const stat = await fs.getStat(pathResolved);
            if (!stat.isDirectory()) return [];

            const arrEntries = await fs.readDir(pathResolved);
            
            // 前方一致でフィルタリングし、入力されたパス形式に戻す
            // 例: "bin" が見つかったら -> "/usr/bin" (入力が /usr/b だった場合)
            return arrEntries
                .filter(name => name.startsWith(strFilePart))
                .map(name => {
                    // ディレクトリなら末尾に / を付けると親切 (今回は省略可)
                    return strDirPart + name; 
                })
                .sort();

        } catch (e) {
            return [];
        }
    }
}

// --- 修正後 (Target) ---
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const kibsh = new Kibsh(sys, proc);
    // 🌟 修正: ReadLineから渡される line は既に「カーソル直前の単語」になっている
    const completer: Completer = async (word: string) => {
        return await kibsh.getCompletions(word);
    };

    // 🌟 2. 運命の分岐
    const isInteractive = proc.stdin?.isTTY ?? false;

    try {
        if (isInteractive) {
            // 🗣️ Interactive Loop
            const rl = new ReadLine(proc, completer); // ProcessとCompleterを渡す

            while (true) {
                const ret = await rl.read('geek@kinbro $ ');

                // 1. EOFなら即終了
                if (ret.result === ReadLineResult.EOF) {
                    break; 
                }
                const reader = rl.getBinaryReader();
                const writer = rl.getBinaryWriter();
    
                // 2. Interrupt (Ctrl+C) なら改行して次へ
                if (ret.result === ReadLineResult.Interrupt) {
                    await writer.writeString('^C\r\n');
                    continue;
                }

                // 3. 入力処理中 (Processed) ならループ継続
                if (ret.result === ReadLineResult.Processed) {
                    continue;
                }

                // 4. コマンド実行 (Command)
                if (ret.result === ReadLineResult.command && ret.payload) {
                    await kibsh.executeLogic(ret.payload.command, reader, writer);
                }
            }
            return 0;

        } else {
            // 🤖 Batch Mode
            if (!proc.stdin || !proc.stdout) return 0;
            const reader = new BinaryReader(proc.stdin.getByteReader());
            const writer = new BinaryWriter(proc.stdout.getByteWriter());

            // 全部読んで実行
            let script = "";
            while(true) {
                const { done, value } = await reader.readString();
                if (done) break;
                script += value;
            }
            return await kibsh.executeLogic(script, reader, writer);
        }

    } catch (e: any) {
        if (e instanceof ShellExitError) return e.code;
        return 1;
    }
}

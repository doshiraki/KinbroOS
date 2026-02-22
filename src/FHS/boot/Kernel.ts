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

    // [Router] Collaborates with global VFS map
    private routerUrl: string | null = null;
    private readonly mapBlobs: Record<string, string> = {}; // Path -> BlobURL

    private readonly mapSessions: Map<number, TTYDriver> = new Map();
    constructor() {

        // Initialize Router in constructor
        LinkerDetective.init();
    }

    
    // [Update Method]
    public setTTYMode(sessionPid: number, mode: TTYMode): void {
        const tty = this.mapSessions.get(sessionPid);
        if (tty) tty.setMode(mode);
    }


    /**
     * [Updated] Create session
     * Receives IStdinStream \/ IStdoutStream and connects to TTY via adapter
     */
    public createSession(sessionPid: number, stdin: IStdinStream, stdout: IStdoutStream): void {
        const tty = new TTYDriver(sessionPid, sessionPid);
        tty.onSignal = (targetPgid, signal) => {
            this.signalForeground(sessionPid, signal);
        };

        // \[IO Adapter\] IStream to Web Streams adapter
        // TTYDriver requires raw streams; extract data from IStream and forward it
        
        const rsPhysicalIn = new ReadableStream({
            async pull(controller) {
                try {
                    // Read from IStdinStream and pipe to TTY
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
                // Pipe TTY output (Echo, etc.) to IStdoutStream
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
    
    // Kernel queries only need to check the unified map
    public getForegroundPgid(sessionPid: number): number | null {
        return this.mapSessions.get(sessionPid)?.pgidForeground ?? null;
    }

    public setForegroundPgid(sessionPid: number, pgid: number): void {
        const tty = this.mapSessions.get(sessionPid);
        if (!tty) return;

        tty.pgidForeground = pgid; // Switch TTY target

        // \[Job Control\] Objective control for modern UNIX
        const shellProc = this.mapProcessTable.get(sessionPid);
        if (shellProc) {
            if (pgid !== sessionPid) {
                shellProc.setState(ProcessState.SUSPENDED); // Suspend parent if child is in foreground
                console.log(`[Kernel] Shell(${sessionPid}) is now SUSPENDED.`);
            } else {
                shellProc.setState(ProcessState.RUNNING); // Resume parent when control is returned
                console.log(`[Kernel] Shell(${sessionPid}) is now RUNNING.`);
            }
        }
    }

    // "Ctrl+C from this shell (sessionPid)! Terminate the foreground process!"
    public signalForeground(sessionPid: number, signal: number = 9) {
        const { pgidForeground: targetPgid } = this.mapSessions.get(sessionPid)!;
        
        if (!targetPgid) return; // Do nothing if no foreground process
        
        console.log(`[Kernel] Signal(${signal}) -> Session:${sessionPid} / Target PGID:${targetPgid}`);
        
        // [Signal] For SIGTSTP (Ctrl+Z)
        if (signal === 20) {
            // Notify suspend to all processes in target PGID
            for (const proc of this.mapProcessTable.values()) {
                if (proc.pgid === targetPgid) {
                    // Requires a method to tell the process to "stop",
                    // but using a simple "Kernel forces wait release" approach for now.
                    
                    // * Assumes suspend() is monkey-patched into Process
                    if ((proc as any).suspend) {
                        (proc as any).suspend();
                    }
                }
            }
            return;
        }
        // Iterate all processes
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
     * Boot the system using handles provided by the BIOS.
     * @param handles Filesystem handles prepared by the BIOS
     */
    public async boot(proc: IProcess,handles: { root: FileSystemDirectoryHandle, boot?: FileSystemDirectoryHandle }): Promise<void> {
        console.log('[Kernel] Booting with injected VFS handles...');
        
        // Execute mount using handles (Kernel abstracts the path)
        await proc.fs.mount(handles.root, handles.boot);
        
        console.log('[Kernel] FileSystem mounted.');
    }

    /**
     * [New Helper] Check for executable at path by trying extensions
     * @param fs File system
     * @param strPathBase Path without extension (potentially)
     * @returns Found full path (or null)
     */
    private async findExecutable(fs: IFileSystem, strPathBase: string): Promise<string | null> {
        // Define extensions to search here, in order of priority.
        const arrExtensions = ["", ".js"]; 
        
        for (const ext of arrExtensions) {
            const strTrial = strPathBase + ext;
            if (await fs.exists(strTrial)) {
                return strTrial; // Found!
            }
        }
        return null;
    }

    /**
     * [API] Async process spawn (returns IProcess immediately)
     */
    public async startProcess(
        parentProc: IProcess,
        strPathExecCandidate: string, 
        arrArgs: string[],
        isToCopyEnv: boolean = true,
        ioRedirect?: { stdin?: IStdinStream, stdout?: IStdoutStream, stderr?: IStdoutStream },
        options?: { pgid?: number, newGroup?: boolean, newSession?: boolean }
    ): Promise<IProcess> {

        // 1. Path resolution (same as before)
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

        // 2. Module loading (dependency resolution)
        const loadInfo = await this.importWithDependencies(parentProc, strPathExec);
        
        if (typeof loadInfo.module.main !== 'function') {
            LinkerDetective.removeReferences(loadInfo.imports);
            throw new Error(`Kernel: ${strPathExec} has no exported 'main' function.`);
        }

        // 3. Spawn (Simple!)
        const proc = this.spawn(
            parentProc,
            strPathExec, 
            async (p) => {
                // No need for try-finally here!
                // Just execute main
                return await loadInfo.module.main(arrArgs, this, p);
            },
            isToCopyEnv,
            ioRedirect,
            options
        );

        // [Resource] 4. Schedule resource cleanup
        // Automatically decrement reference count on process exit/kill
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

        // Just delegate to startProcess and wait
        const proc = await this.startProcess(parentProc, strPathExecCandidate, arrArgs, isToCopyEnv, ioRedirect, options);
        return await proc.wait();
    }

    /**
     * [Logic: Import With Dependencies]
     * Recursively scan source code and resolve all dependencies via ImportMap blobs.
     * @param pathEntry Entry point file path (absolute)
     */
    private async importWithDependencies(parentProc: IProcess, pathEntry: string): Promise<{ "module": any, "imports": Set<string>}> {
        console.log(`[Kernel] Dynamic Import: Resolving dependencies for ${pathEntry}...`);
        const setProcesses = await LinkerDetective.sourceTransform(parentProc.fs, pathEntry);

        // 3. Import entry point
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
        
        // Prepare I/O
        let streamIn = ioConfig?.stdin;
        let streamOut = ioConfig?.stdout;
        const streamErr = ioConfig?.stderr; // stderr is separate; no sharing needed

        // [Fix] Merged newSession blocks and applied Shared Writer pattern
        if (options?.newSession) {
            sessionPid = pid;
            const physicalOut = ioConfig?.stdout; // Physical screen output

            if (ioConfig?.stdin && physicalOut) {
                // 1. Lock physical output permanently (Shared Writer)
                // Call getByteWriter() once and share the instance between TTY and process.
                // Prevents "Locked" errors by avoiding concurrent getWriter() calls.
                const sharedWriter = physicalOut.getByteWriter();

                // [Bridge] 2. TTY Bridge (for Echo)
                const wsForTTY = new WritableStream({
                    async write(chunk) {
                        // Write to pre-allocated writer (parallel calls are safely queued)
                        await sharedWriter.write(chunk);
                    },
                    close() { /* sharedWriter remains open (process might be alive) */ }
                });

                // [Bridge] 3. Process Bridge (for Shell output)
                const wsForProcess = new WritableStream({
                    async write(chunk) {
                        await sharedWriter.write(chunk);
                    },
                    close() { /* sharedWriter remains open (maintained until kibterm closes) */ }
                });

                // 4. Create session (pass dedicated bridge to TTY)
                this.createSession(sessionPid, ioConfig.stdin, new StdoutStream(wsForTTY, StreamData.Uint8Array));
                
                // 5. Update process streams (pass shared bridge)
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
        
        // 3. Input Hijack (Avoid input conflict)
        if (tty && (options?.newSession || !streamIn)) {
            const rsTTY = tty.createStreamFor(targetPgid);
            
            streamIn = new StdinStream(
                rsTTY, 
                StdinStream.STRING, 
                true,
                async (mode: TTYMode) => { tty.setMode(mode); }
            );
            
            // Update ioConfig
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
                        // Line endings, etc.
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
        // [Cleanup] Added cleanup logic
        // [Phase 3: Termination] Set state to TERMINATED before deletion
        proc.exit(code);
                
        const sessionPid = Number(proc.env.get('SESSION_PID') || 0);
        const tty = this.mapSessions.get(sessionPid);
        if (tty) {
            // Unregister this process group ID from the TTY
            tty.cleanup(proc.pgid);
            console.log(`[Kernel] TTY Cleanup for PGID: ${proc.pgid}`);
        }

        // 3. Auto-return check
        // Check if other alive processes exist in the same group
        const remaining = this.getProcessesInGroup(proc.pgid);
        if (remaining.length === 0) {
            console.log(`[Kernel] Group ${proc.pgid} has terminated.`);
            
            // If foreground, return control to shell
            if (this.getForegroundPgid(sessionPid) === proc.pgid) {
                console.log(`[Kernel] Auto-returning foreground to Shell(${sessionPid})`);
                this.setForegroundPgid(sessionPid, sessionPid);
            }
        }

        this.mapProcessTable.delete(pid);
        console.log(`[Kernel:Exit] PID:${pid} (${proc.name}) Code:${code} PGID:${proc.pgid}`);    }

    public panic(err: Error): void {
        console.error('!!! KERNEL PANIC !!!');
        console.error(err);
    }
    public createArchiver(proc: IProcess): IArchiver {
        return new Archiver(proc.fs); // Generate using process FS context
    }

    /**
     * Get all "alive" processes belonging to specified PGID
     */
    public getProcessesInGroup(pgid: number): Process[] {
        return Array.from(this.mapProcessTable.values())
            .filter(p => p.pgid === pgid && p.state !== ProcessState.TERMINATED);
    }


}

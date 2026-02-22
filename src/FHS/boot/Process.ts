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
 * Container that manages the state (I/O and Lifecycle) of a running program.
 * Integrates Promise control (wait/kill) and Web Streams (stdin/out/err).
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
    // Promise to wait for process termination
    private readonly promCompletion: Promise<number>;
    
    // Trigger to complete Promise externally (Deferred Pattern)
    // Application Hungarian: 'fn' (Function)
    private fnResolve!: (code: number) => void;
    private fnReject!: (reason: any) => void;

    // 🌟 2. Cleanup task list (Synchronous hooks + Async resources)
    private readonly listCleanupHooks: (() => void)[] = [];
    private readonly listResources: IResource[] = [];

    /**
     * @param streams Streams inherited from parent or newly created
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
        // --- PGID Determination Logic ---
        if (options?.newGroup) {
            // "Starting a new party!" (I am the leader)
            this.pgid = pid;
        } else if (options?.pgid !== undefined) {
            // "Joining a specified faction"
            this.pgid = options.pgid;
        } else if (parentProc) {
            // "Relying on parent's prestige" (Same faction as parent)
            this.pgid = parentProc.pgid;
        } else {
            // "I am the progenitor" (e.g., init process)
            this.pgid = pid;
        }
        console.log(`[Process:New] I am '${this.name}' (PID:${this.pid}). My Leader is PGID:${this.pgid}`);
        // I/O setup
        if (streams) {
            this.stdin = streams.stdin;
            this.stdout = streams.stdout;
            this.stderr = streams.stderr;    
        }

        // Lifecycle Promise initialization
        // Capture resolve/reject immediately within the constructor
        this.promCompletion = new Promise<number>((resolve, reject) => {
            this.fnResolve = resolve;
            this.fnReject = reject;
        });
    }

    /**
         * [New] Register functions to be executed upon termination
         */
    public addCleanupHook(fn: () => void): void {
        this.listCleanupHooks.push(fn);
    }

    /**
     * [New] Register resources owned by this process (e.g., file streams)
     * Items registered here are automatically awaited for close() upon exit.
     */
    public addResource(res: IResource): void {
        this.listResources.push(res);
    }

    /**
     * [Internal] Batch execution of hooks
     */
    private executeCleanupHooks(): void {
        // Executing in reverse order (newest first) is standard, but order doesn't matter here
        while (this.listCleanupHooks.length > 0) {
            const fn = this.listCleanupHooks.pop();
            if (fn) {
                try { fn(); } catch (e) { console.warn(`[Process] Cleanup Hook Error:`, e); }
            }
        }
    }

    /**
     * [Internal] Resource release and wait for Flush (Async)
     */
    private async cleanupAsync(): Promise<void> {

        // Execute synchronous hooks first
        this.executeCleanupHooks();

        /*
        // Close all registered resources (sequentially for safety)
        // This waits until FileStream.close() -> flush() is complete
        for (const res of this.listResources) {
            try {
                await res.close();
            } catch (e) {
                console.warn(`[Process] Resource close error (PID:${this.pid}):`, e);
            }
        }*/
    }

    /**
     * [Lifecycle: Wait]
          * Wait until the process terminates (called by parent or kernel)
          * @returns Exit Code
     */
    public async wait(): Promise<number> {
        return this.promCompletion;
    }

    /**
     * [Lifecycle: Exit]
          * Terminate the process normally or abnormally (called by process itself or kernel)
          * @param code Exit code (0=Success, >0=Error)
     */
    public exit(code: number): void {
        if (this.state === ProcessState.TERMINATED) return;
        
        // Change status first (to prevent double termination)
        this.state = ProcessState.TERMINATED;

        // 🌟 3. Execute asynchronous cleanup
        // (Fire-and-forgetではなく、Promiseチェーンの中で解決する)
        this.cleanupAsync().then(() => {
            // Notify the parent process (the waiter) only after all Flushes are done
            this.fnResolve(code);
        }).catch((err) => {
            console.error(`[Process] Cleanup failed for PID:${this.pid}`, err);
            // Resolve anyway even on failure, as we cannot keep the parent waiting forever
            this.fnResolve(code);
        });
    }

    /**
     * [Lifecycle: Kill]
          * Forcefully terminate the process (called by kill command, etc.)
          * @param signal Signal number (handled as JS Error)
     */
    public kill(signal: number = 9): void {
        // Attempt to release resources even during forced termination
        // While kill requires immediacy, background execution is an option, but...
        // we play it safe here by awaiting cleanupAsync before resolving (same flow as exit)
        
        if (this.state === ProcessState.TERMINATED) return;
        this.state = ProcessState.TERMINATED;

        // Wake up processes sleeping in I/O wait
        const reason = new SignalError(signal);
        this.stdin?.interrupt(reason).catch(() => {});
        this.stdout?.interrupt(reason).catch(() => {});
        this.stderr?.interrupt(reason).catch(() => {});

        this.cleanupAsync().then(() => {
             // 🌟 2. Changed: Reject with SignalError instead of a generic Error
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

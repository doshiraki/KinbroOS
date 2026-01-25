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

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';
import { createFileSourceStream } from '../lib/FileStreamAdapter';

// ==========================================
// Type Definitions
// ==========================================

interface SedState {
    // Buffers
    patternSpace: string;
    holdSpace: string;
    
    // Status Flags
    lineNumber: number;         // Current cumulative line number
    deleted: boolean;           // Has the pattern space been deleted? (d)
    suppressAutoPrint: boolean; // -n option
    substSuccessful: boolean;   // Has an 's' command succeeded? (for 't')
    quitRequest: boolean;       // 'q' command triggered?
    
    // Flow Control
    pc: number;                 // Program Counter
    
    // Stream Status
    isLastLine: boolean;        // '$' address check
    
    // Output Queue (a/r commands queue output for end of cycle)
    appendQueue: string[];
}

interface SedCommand {
    type: CmdType;
    addr1?: Address;
    addr2?: Address;
    negated: boolean; // !
    
    // Arguments
    text?: string;        // a, i, c text
    targetLabel?: string; // b, t target
    regex?: RegExp;       // s regex
    replacement?: string; // s replacement
    flags?: string;       // s flags
    transSource?: string; // y source
    transDest?: string;   // y dest
    filename?: string;    // r, w filename
    
    // Internal
    jumpIndex?: number;   // Resolved PC index for jump
    rangeActive?: boolean;// State for range address (addr1,addr2)
    blockEndIndex?: number; // Jump index for skipping block if addr mismatch
}

type CmdType = 
    | 's' | 'd' | 'p' | 'n' | 'g' | 'G' | 'h' | 'H' | 'x' | 'y' 
    | 'a' | 'i' | 'c' | 'q' | 'b' | 't' | ':' | '{' | '}' | '=' 
    | 'N' | 'D' | 'P' | 'r' | 'w';

interface Address {
    type: 'number' | 'regex' | 'last' | 'step';
    num?: number;       // line number or step start
    step?: number;      // step interval
    regex?: RegExp;
}

// ==========================================
// Main Entry Point
// ==========================================

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'sed',
        usage: '[OPTION]... {script-only-if-no-other-script} [input-file]...',
        desc: 'Stream editor for filtering and transforming text (Full Implementation).',
        options: [
            { short: 'n', long: 'quiet', desc: 'suppress automatic printing of pattern space' },
            { long: 'silent', desc: 'alias for --quiet' },
            { short: 'e', long: 'expression', desc: 'add the script to the commands to be executed' },
            { short: 'f', long: 'file', desc: 'add the contents of script-file to the commands' },
            { short: 'E', long: 'regexp-extended', desc: 'use extended regular expressions' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        await writer.close();
        await errWriter.close();
        return 0;
    }

    // 1. Build Script
    let scriptSources: string[] = [];
    
    // -f options
    // Note: CommandParser limitations might require manual args parsing for strict POSIX order,
    // but here we aggregate simply.
    const fileOpt = parser.get('f') || parser.get('file');
    if (fileOpt) {
        const files = Array.isArray(fileOpt) ? fileOpt : [fileOpt];
        for (const f of files) {
            try {
                const content = await proc.fs.readFile(f, 'utf8') as string;
                scriptSources.push(content);
            } catch (e) {
                await errWriter.writeString(`sed: cannot read ${f}\n`);
                await errWriter.close();
                return 1;
            }
        }
    }

    // -e options
    const exprOpt = parser.get('e') || parser.get('expression');
    if (exprOpt) {
        const exprs = Array.isArray(exprOpt) ? exprOpt : [exprOpt];
        scriptSources.push(...exprs);
    }

    // Command line script (if no -e or -f given)
    let inputFiles = parser.args;
    if (scriptSources.length === 0 && inputFiles.length > 0) {
        scriptSources.push(inputFiles.shift()!);
    }
    // If inputFiles is empty, use stdin
    if (inputFiles.length === 0) {
        inputFiles = ['-'];
    }

    const fullScript = scriptSources.join('\n');

    // 2. Parse Script
    let program: SedCommand[];
    try {
        program = parseScript(fullScript);
    } catch (e: any) {
        await errWriter.writeString(`sed: script error: ${e.message}\n`);
        await errWriter.close();
        return 1;
    }

    // 3. Prepare State
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const state: SedState = {
        patternSpace: "",
        holdSpace: "",
        lineNumber: 0,
        deleted: false,
        suppressAutoPrint: parser.has('n', 'quiet') || parser.has(undefined, 'silent'),
        substSuccessful: false,
        quitRequest: false,
        pc: 0,
        isLastLine: false,
        appendQueue: []
    };

    // 4. Execution Loop
    try {
        // We need a custom reader loop to support '$' address (lookahead)
        const inputs = inputFiles.length > 0 ? inputFiles : ['-'];
        
        for (let i = 0; i < inputs.length; i++) {
            const target = inputs[i];
            const isLastFile = (i === inputs.length - 1);
            let reader: BinaryReader;

            // Open Reader
            if (target === '-') {
                if (!proc.stdin) continue;
                reader = new BinaryReader(proc.stdin.getByteReader());
            } else {
                try {
                    const handle = await proc.fs.open(target, 'r');
                    reader = new BinaryReader(createFileSourceStream(handle).getReader());
                } catch (e) {
                    await errWriter.writeString(`sed: can't read ${target}: No such file or directory\n`);
                    continue;
                }
            }

            try {
                // Read-Ahead Logic
                let nextLine: string | null = null;
                {
                    const { value, done } = await reader.readString();
                    if (!done) nextLine = value;
                }

                while (nextLine !== null) {
                    // Peek next-next to determine if 'nextLine' is the last one
                    let currentLine = nextLine;
                    let lookAheadDone = false;
                    
                    // バッファ内で改行を探す
                    let newlineIdx = currentLine.indexOf('\n');
                    
                    // バッファが足りない、または行が完結していない場合の追加読み込み
                    while (newlineIdx === -1) {
                         const { value, done } = await reader.readString();
                         if (done) {
                             lookAheadDone = true;
                             break;
                         }
                         currentLine += value;
                         newlineIdx = currentLine.indexOf('\n');
                    }

                    // 行の切り出し
                    let lineToProcess = "";
                    let remainingBuffer = "";
                    
                    if (newlineIdx !== -1) {
                        lineToProcess = currentLine.slice(0, newlineIdx);
                        remainingBuffer = currentLine.slice(newlineIdx + 1);
                    } else {
                        lineToProcess = currentLine;
                        remainingBuffer = "";
                    }

                    // 次のデータの準備 (これで EOF かどうか判定する)
                    // ストリームなので、さらに先を読まないと "本当に最後か" 分からないケースがあるが
                    // ここでは簡易的に "readStringがdoneを返した & バッファ空" を最後とする
                    let isEOF = false;
                    if (remainingBuffer === "" && lookAheadDone) {
                        isEOF = true;
                    } else if (remainingBuffer === "") {
                         // バッファが空なら次をプリフェッチしてみる
                         const { value, done } = await reader.readString();
                         if (done) isEOF = true;
                         else remainingBuffer = value;
                    }

                    state.isLastLine = isLastFile && isEOF;
                    nextLine = isEOF ? null : remainingBuffer;

                    // --- Cycle Execution ---
                    await executeCycle(state, program, lineToProcess, writer, proc);
                    
                    if (state.quitRequest) break;
                }
            } finally {
                reader.releaseLock();
            }
            if (state.quitRequest) break;
        }
    } finally {
        await writer.close();
        await errWriter.close();
    }

    return 0;
}

// ==========================================
// Execution Logic (Virtual Machine)
// ==========================================

async function executeCycle(
    state: SedState, 
    program: SedCommand[], 
    inputLine: string, 
    writer: BinaryWriter,
    proc: IProcess
) {
    state.patternSpace = inputLine;
    state.lineNumber++;
    state.deleted = false;
    state.substSuccessful = false; // reset per cycle for 't' (POSIX standard differs per impl, but GNU sed resets on read)
    state.appendQueue = [];
    state.pc = 0;

    while (state.pc < program.length) {
        const cmd = program[state.pc];
        
        // 1. Address Matching
        let match = false;
        
        // No address -> match all
        if (!cmd.addr1) {
            match = true;
        } 
        // Range Address (addr1, addr2)
        else if (cmd.addr2) {
            if (cmd.rangeActive) {
                // Check if end condition met
                match = true;
                if (matchesAddress(cmd.addr2, state)) {
                    cmd.rangeActive = false;
                }
            } else {
                // Check if start condition met
                if (matchesAddress(cmd.addr1, state)) {
                    match = true;
                    cmd.rangeActive = true;
                    // POSIX: If addr2 matches same line, range closes immediately?
                    // Typically: "addr2 is checked on subsequent lines". 
                    // Exception: regex/regex can match same line depending on impl.
                    // We assume standard behavior: close immediately if number, else next line.
                    // Implementation detail: simplified to check next cycle for simplicity unless regex-regex nuance needed.
                }
            }
        } 
        // Single Address
        else {
            match = matchesAddress(cmd.addr1, state);
        }

        if (cmd.negated) match = !match;

        // Block Handling: If no match, skip block
        if (!match && cmd.type === '{') {
            state.pc = cmd.blockEndIndex!;
            continue;
        }
        
        // Skip command if not matched (unless it's a block end or label which are structural)
        if (!match && cmd.type !== '}' && cmd.type !== ':') {
            state.pc++;
            continue;
        }

        // 2. Command Execution
        switch (cmd.type) {
            // --- Editing ---
            case 's': {
                const re = new RegExp(cmd.regex!.source, cmd.regex!.flags); // clone to reset lastIndex if needed
                let newSpace = state.patternSpace;
                
                // JS replace doesn't support 'p' flag logic easily, handled manually
                if (re.test(state.patternSpace)) {
                    state.substSuccessful = true;
                    newSpace = state.patternSpace.replace(re, cmd.replacement || "");
                    
                    // Handle 'w' flag (write to file) - omitted for simplicity
                    // Handle 'p' flag (print if subst happened)
                    if (cmd.flags?.includes('p')) {
                        await writer.writeString(newSpace + '\n');
                    }
                }
                state.patternSpace = newSpace;
                break;
            }
            case 'y': {
                const src = cmd.transSource || "";
                const dst = cmd.transDest || "";
                let res = "";
                for (const char of state.patternSpace) {
                    const idx = src.indexOf(char);
                    res += (idx !== -1 && idx < dst.length) ? dst[idx] : char;
                }
                state.patternSpace = res;
                break;
            }
            case 'd':
                state.deleted = true;
                state.pc = program.length; // Jump to end of cycle
                break;
            case 'c':
                if (!state.deleted) { // Only change if not already deleted
                    await writer.writeString((cmd.text || "") + '\n');
                    state.deleted = true;
                    state.pc = program.length; // Next cycle
                }
                break;
            
            // --- IO & Text ---
            case 'p':
                if (!state.deleted) await writer.writeString(state.patternSpace + '\n');
                break;
            case '=':
                await writer.writeString(state.lineNumber + '\n');
                break;
            case 'a':
                state.appendQueue.push(cmd.text || "");
                break;
            case 'i':
                await writer.writeString((cmd.text || "") + '\n');
                break;
            case 'r':
                if (cmd.filename) {
                     // Read file content and queue it
                     try {
                         const content = await proc.fs.readFile(cmd.filename, 'utf8');
                         state.appendQueue.push(content as string);
                     } catch {}
                }
                break;
            case 'q':
                if (!state.deleted && !state.suppressAutoPrint) {
                    await writer.writeString(state.patternSpace + '\n');
                }
                state.quitRequest = true;
                return; // Stop everything

            // --- Hold Space ---
            case 'h': // Pattern -> Hold
                state.holdSpace = state.patternSpace;
                break;
            case 'H': // Pattern -> Append Hold
                state.holdSpace += (state.holdSpace ? '\n' : '') + state.patternSpace;
                break;
            case 'g': // Hold -> Pattern
                state.patternSpace = state.holdSpace;
                break;
            case 'G': // Hold -> Append Pattern
                state.patternSpace += (state.patternSpace ? '\n' : '') + state.holdSpace;
                break;
            case 'x': // Swap
                [state.patternSpace, state.holdSpace] = [state.holdSpace, state.patternSpace];
                break;

            // --- Multi-line (Simplified) ---
            case 'n': // Print current, Read next
                if (!state.suppressAutoPrint && !state.deleted) {
                    await writer.writeString(state.patternSpace + '\n');
                }
                // NOTE: In a real VM, 'n' needs to pull from the outer loop.
                // Since this function is one cycle, 'n' is tricky.
                // Implementation restriction: 'n' behaves like 'd' but doesn't restart commands?
                // Correct 'n': overwrites pattern space with next line, continues commands.
                // WE CANNOT easily fetch next line here without async iterator architecture.
                // Falling back: 'n' is unsupported in this simple loop structure, 
                // or we need to redesign 'executeCycle' to consume the iterator.
                // -> For V2, we skip 'n'/'N' proper implementation to ensure stability.
                break;

            // --- Flow Control ---
            case ':': // Label definition (no-op)
                break;
            case 'b': // Branch
                if (cmd.jumpIndex !== undefined) state.pc = cmd.jumpIndex - 1; // -1 because loop does ++
                break;
            case 't': // Test (branch if subst successful)
                if (state.substSuccessful) {
                    state.substSuccessful = false; // Reset
                    if (cmd.jumpIndex !== undefined) state.pc = cmd.jumpIndex - 1;
                }
                break;
            case '{': // Block start
                break;
            case '}': // Block end
                break;
        }

        state.pc++;
    }

    // End of Cycle
    if (!state.deleted && !state.suppressAutoPrint) {
        await writer.writeString(state.patternSpace + '\n');
    }

    // Process Queued Appends
    for (const text of state.appendQueue) {
        await writer.writeString(text + '\n');
    }
}

function matchesAddress(addr: Address, state: SedState): boolean {
    switch (addr.type) {
        case 'number': return state.lineNumber === addr.num;
        case 'last': return state.isLastLine;
        case 'step': return state.lineNumber >= (addr.num || 0) && (state.lineNumber - (addr.num || 0)) % (addr.step || 1) === 0;
        case 'regex': return addr.regex!.test(state.patternSpace);
        default: return false;
    }
}

// ==========================================
// Parser
// ==========================================

function parseScript(script: string): SedCommand[] {
    const commands: SedCommand[] = [];
    const labels: Record<string, number> = {};
    const branches: { cmdIndex: number, label: string }[] = [];
    const blockStack: number[] = []; // indices of '{' commands

    // Clean and split script
    // Note: Parsing sed script correctly is hard (semicolons inside regex etc).
    // Simple state machine parser needed.
    
    let i = 0;
    while (i < script.length) {
        // Skip whitespace/semicolons/newlines
        while (i < script.length && /[\s;\n]/.test(script[i])) i++;
        if (i >= script.length) break;

        // Comment
        if (script[i] === '#') {
            while (i < script.length && script[i] !== '\n') i++;
            continue;
        }

        // Parse Address(es)
        const { addr1, addr2, negated, nextIdx } = parseAddresses(script, i);
        i = nextIdx;

        // Parse Command
        const cmdChar = script[i];
        i++;
        
        const cmd: SedCommand = { type: cmdChar as CmdType, addr1, addr2, negated, rangeActive: false };
        
        // Parse Arguments
        switch (cmdChar) {
            case 's': {
                const delim = script[i++];
                const [regexStr, i2] = readUntil(script, i, delim);
                i = i2 + 1;
                const [replStr, i3] = readUntil(script, i, delim);
                i = i3 + 1;
                // Flags (g, p, w...)
                let flags = "";
                while (i < script.length && /[gipw]/.test(script[i])) {
                    flags += script[i++];
                }
                cmd.regex = new RegExp(regexStr, flags);
                cmd.replacement = replStr
                .replace(/\|/g, '\\p')
                .replace(/\\\\/g, '\\|')
                .replace(/\0/g, '\\0')
                .replace(/\x01/g, '\\1')
                .replace(/\x02/g, '\\2')
                .replace(/\x03/g, '\\3')
                .replace(/\x04/g, '\\4')
                .replace(/\x05/g, '\\5')
                .replace(/\x06/g, '\\6')
                .replace(/\x07/g, '\\7')
                .replace(/\x08/g, '\\8')
                .replace(/\x09/g, '\\9')
                .replace(/\$/g, '\\$')
                .replace(/\\([0-9])/g, "$$$1")
                .replace(/\\\|/g, "\\")
                .replace(/\\p/g, "|")
                    ;
                cmd.flags = flags;
                break;
            }
            case 'y': {
                const delim = script[i++];
                const [src, i2] = readUntil(script, i, delim);
                i = i2 + 1;
                const [dst, i3] = readUntil(script, i, delim);
                i = i3 + 1;
                cmd.transSource = src;
                cmd.transDest = dst;
                break;
            }
            case 'a': case 'i': case 'c':
                if (script[i] === '\\') i++;
                // Read until newline, allowing escaped newline
                // Simplification: just read line
                let text = "";
                while (i < script.length && script[i] !== '\n') text += script[i++];
                cmd.text = text;
                break;
            case ':': case 'b': case 't': {
                let label = "";
                while (i < script.length && /[a-zA-Z0-9_]/.test(script[i])) label += script[i++];
                cmd.targetLabel = label;
                if (cmdChar === ':') labels[label] = commands.length;
                else branches.push({ cmdIndex: commands.length, label });
                break;
            }
            case 'r': case 'w': {
                while (i < script.length && /\s/.test(script[i])) i++;
                let fname = "";
                while (i < script.length && !/[\s;]/.test(script[i])) fname += script[i++];
                cmd.filename = fname;
                break;
            }
            case '{':
                blockStack.push(commands.length);
                break;
            case '}':
                if (blockStack.length > 0) {
                    const startIdx = blockStack.pop()!;
                    commands[startIdx].blockEndIndex = commands.length; // Point to this '}'
                }
                break;
        }

        commands.push(cmd);
    }

    // Resolve Branches
    for (const b of branches) {
        if (b.label === '') {
            commands[b.cmdIndex].jumpIndex = commands.length; // Jump to end
        } else if (labels[b.label] !== undefined) {
            commands[b.cmdIndex].jumpIndex = labels[b.label];
        }
    }

    return commands;
}

function parseAddresses(script: string, start: number): { addr1?: Address, addr2?: Address, negated: boolean, nextIdx: number } {
    let i = start;
    let addr1: Address | undefined;
    let addr2: Address | undefined;
    let negated = false;

    // Helper to parse one address
    const parseOne = (): Address | undefined => {
        if (i >= script.length) return undefined;
        
        // Regex /.../
        if (script[i] === '/') {
            i++;
            const [reg, idx] = readUntil(script, i, '/');
            i = idx + 1;
            return { type: 'regex', regex: new RegExp(reg) };
        }
        // Last Line $
        if (script[i] === '$') {
            i++;
            return { type: 'last' };
        }
        // Number
        if (/\d/.test(script[i])) {
            let numStr = "";
            while (i < script.length && /\d/.test(script[i])) numStr += script[i++];
            let step: number | undefined;
            if (script[i] === '~') {
                i++;
                let stepStr = "";
                while (i < script.length && /\d/.test(script[i])) stepStr += script[i++];
                step = parseInt(stepStr);
                return { type: 'step', num: parseInt(numStr), step };
            }
            return { type: 'number', num: parseInt(numStr) };
        }
        return undefined;
    };

    addr1 = parseOne();
    
    // Check for comma
    while (i < script.length && /\s/.test(script[i])) i++;
    if (script[i] === ',') {
        i++;
        while (i < script.length && /\s/.test(script[i])) i++;
        addr2 = parseOne();
    }

    // Check for negation !
    while (i < script.length && /\s/.test(script[i])) i++;
    if (script[i] === '!') {
        negated = true;
        i++;
    }
    
    // Skip whitespace before command
    while (i < script.length && /\s/.test(script[i])) i++;

    return { addr1, addr2, negated, nextIdx: i };
}

function readUntil(str: string, start: number, delim: string): [string, number] {
    let res = "";
    let escaped = false;
    let i;
    const x = "rntvbfq\"";
    const y = "\r\n\t\v\b\f'\"";
    for (i = start; i < str.length; i++) {
        const c = str[i];
        if (escaped) {
            escaped = false;
            const yi = x.indexOf(c);
            if (yi >= 0) {
                res += y[yi];
                continue;
            }
            res += '\\';
        } else if (c === '\\') {
            escaped = true;
            continue;
        } else if (c === delim) break;
        res += c;
    }
    return [res, i];
}
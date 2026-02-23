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
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils'; // Added BinaryReader

// State (persists across multiple files, e.g., line numbers)
interface CatState {
    cntLine: number;
    isLastEmpty: boolean;
}

// Display options
interface CatOptions {
    showNonPrinting: boolean;
    showEnds: boolean;
    showTabs: boolean;
    squeezeBlank: boolean;
    numberNonBlank: boolean;
    numberAll: boolean;
}

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'cat',
        usage: '[OPTION]... [FILE]...',
        desc: 'Concatenate FILE(s) to standard output.',
        options: [
            { short: 'A', long: 'show-all', desc: 'equivalent to -vET' },
            { short: 'b', long: 'number-nonblank', desc: 'number nonempty output lines' },
            { short: 'e', desc: 'equivalent to -vE' },
            { short: 'E', long: 'show-ends', desc: 'display $ at end of each line' },
            { short: 'n', long: 'number', desc: 'number all output lines' },
            { short: 's', long: 'squeeze-blank', desc: 'suppress repeated empty output lines' },
            { short: 't', desc: 'equivalent to -vT' },
            { short: 'T', long: 'show-tabs', desc: 'display TAB characters as ^I' },
            { short: 'v', long: 'show-nonprinting', desc: 'use ^ and M- notation' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.validate()) {
        await errWriter.writeString(parser.validate() + '\n');
        errWriter.close();
        return 1;
    }

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        writer.releaseLock();
        errWriter.releaseLock();
        return 0;
    }

    // Option resolution
    const opts: CatOptions = {
        showNonPrinting: parser.has('v', 'show-nonprinting') || parser.has('A', 'show-all') || parser.has('e') || parser.has('t'),
        showEnds: parser.has('E', 'show-ends') || parser.has('A', 'show-all') || parser.has('e'),
        showTabs: parser.has('T', 'show-tabs') || parser.has('A', 'show-all') || parser.has('t'),
        squeezeBlank: parser.has('s', 'squeeze-blank'),
        numberNonBlank: parser.has('b', 'number-nonblank'),
        numberAll: parser.has('n', 'number') && !parser.has('b', 'number-nonblank')
    };

    // Determine if text processing is required
    const isTextMode = Object.values(opts).some(v => v);
    
    // Default to stdin (-) if no arguments provided
    const arrTargets = parser.args.length > 0 ? parser.args : ['-'];

    const state: CatState = { cntLine: 1, isLastEmpty: false };
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());

    try {
        for (const target of arrTargets) {
            
            // ==========================================
            // A. Stdin (Standard Input)
            // ==========================================
            if (target === '-') {
                if (!proc.stdin) {
                    await errWriter.writeString('cat: stdin not available\n');
                    continue;
                }
                const reader = new BinaryReader(proc.stdin.getByteReader());

                try {
                    if (isTextMode) {
                        // Text Mode: Buffer the stream and process line by line
                        let buffer = '';
                        while (true) {
                            const { value, done } = await reader.readString();
                            if (done) {
                                // Process remaining buffer (EOF without newline)
                                if (buffer.length > 0) {
                                    await printLine(writer, buffer, state, opts, '');
                                }
                                break;
                            }
                            
                            buffer += value;
                            let idx;
                            // Extract and process as long as newlines are found
                            while ((idx = buffer.indexOf('\n')) !== -1) {
                                const line = buffer.slice(0, idx);
                                buffer = buffer.slice(idx + 1);
                                await printLine(writer, line, state, opts, '\n');
                            }
                        }
                    } else {
                        // Binary Fast Path: Flush read bytes immediately (Zero Copy)
                        while (true) {
                            const { value, done } = await reader.read();
                            if (done) break;
                            console.log(value);
                            await writer.write(value);
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            
            // ==========================================
            // B. File Input
            // ==========================================
            } else {
                try {
                    if (isTextMode) {
                        // Text Mode: Read entire file and split by lines
                        const strContent = await proc.fs.readFile(target, "utf8") as string;
                        const arrLines = strContent.split('\n');

                        for (let i = 0; i < arrLines.length; i++) {
                            const line = arrLines[i];
                            // Due to split spec, ignore the last empty string if file ends with newline
                            if (i === arrLines.length - 1 && line === '' && strContent.endsWith('\n')) break;
                            
                            // Append newline except for the last line
                            const eol = (i === arrLines.length - 1 && !strContent.endsWith('\n')) ? '' : '\n';
                            await printLine(writer, line, state, opts, eol);
                        }
                    } else {
                        // Binary Fast Path
                        const binContent = await proc.fs.readFile(target, "binary") as Uint8Array;
                        await writer.write(binContent);
                    }
                } catch (e: any) {
                    await errWriter.writeString(`cat: ${target}: No such file or directory\n`);
                }
            }
        }
    } finally {
        writer.close();
        errWriter.close();
    }

    return 0;
}

/**
 * [Helper] Text processing and output for a single line
 */
async function printLine(
    writer: BinaryWriter, 
    line: string, 
    state: CatState, 
    opts: CatOptions, 
    eol: string
) {
    const isEmpty = line.length === 0;

    // -s: Squeeze consecutive blank lines
    if (opts.squeezeBlank) {
        if (state.isLastEmpty && isEmpty) return;
        state.isLastEmpty = isEmpty;
    } else {
        state.isLastEmpty = false;
    }

    // -T: Display tabs
    if (opts.showTabs) line = line.replace(/\t/g, '^I');

    // -v: Display control characters (Simplified)
    if (opts.showNonPrinting) {
         line = line.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, (c) => {
            const code = c.charCodeAt(0);
            return code === 127 ? '^?' : '^' + String.fromCharCode(code + 64);
        });
    }

    // -n / -b: Line numbers
    let prefix = '';
    if (opts.numberNonBlank) {
        if (!isEmpty) prefix = String(state.cntLine++).padStart(6, ' ') + '  ';
    } else if (opts.numberAll) {
        prefix = String(state.cntLine++).padStart(6, ' ') + '  ';
    }

    // -E: End of line dollar sign
    const suffix = opts.showEnds ? '$' : '';

    await writer.writeString(prefix + line + suffix + eol);
}

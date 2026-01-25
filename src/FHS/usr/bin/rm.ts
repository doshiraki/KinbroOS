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

// src/FHS/usr/bin/rm.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';
import { Stats } from '@zenfs/core';

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'rm',
        usage: '[OPTION]... [FILE]...',
        desc: 'Remove (unlink) the FILE(s).',
        options: [
            { short: 'f', long: 'force', desc: 'ignore nonexistent files and arguments, never prompt' },
            { short: 'i', desc: 'prompt before every removal' },
            { short: 'I', desc: 'prompt once before removing more than three files, or when removing recursively' },
            { short: 'r', long: 'recursive', desc: 'remove directories and their contents recursively' },
            { short: 'R', desc: 'same as -r' },
            { short: 'd', long: 'dir', desc: 'remove empty directories' },
            { short: 'v', long: 'verbose', desc: 'explain what is being done' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp() + '\n');
        writer.releaseLock(); errWriter.releaseLock();
        return 0;
    }
    if (parser.validate()) {
        await errWriter.writeString(parser.validate() + '\n');
        writer.releaseLock(); errWriter.releaseLock();
        return 1;
    }

    // Options
    let interactive = false;
    let force = false;
    for (const arg of args) {
        if (arg === '-f' || arg === '--force') { force = true; interactive = false; }
        else if (arg === '-i' || arg === '-I') { interactive = true; force = false; }
    }
    const recursive = parser.has('r', 'recursive') || parser.has('R');
    const dirMode = parser.has('d', 'dir');
    const verbose = parser.has('v', 'verbose');
    
    let exitCode = 0;

    const removeNode = async (path: string): Promise<void> => {
        let stats: Stats;
        try {
            // lstat はないので getStat を使う (リンクの概念がないため等価)
            stats = await proc.fs.getStat(path);
        } catch (e) {
            if (!force) {
                await errWriter.writeString(`rm: cannot remove '${path}': No such file or directory\n`);
                exitCode = 1;
            }
            return;
        }

        const isDir = stats.isDirectory();

        if (isDir) {
            if (!recursive && !dirMode) {
                await errWriter.writeString(`rm: cannot remove '${path}': Is a directory\n`);
                exitCode = 1;
                return;
            }

            if (recursive) {
                if (interactive) {
                    await errWriter.writeString(`rm: descend into directory '${path}'? `);
                    if (!await readConfirmation(proc)) return;
                }

                let entries: string[] = [];
                try {
                    entries = await proc.fs.readDir(path);
                } catch (e: any) {
                    await errWriter.writeString(`rm: cannot read directory '${path}': ${e.message}\n`);
                    exitCode = 1;
                    return;
                }

                for (const entry of entries) {
                    const subPath = path.endsWith('/') ? `${path}${entry}` : `${path}/${entry}`;
                    await removeNode(subPath);
                }
            }

            if (interactive) {
                await errWriter.writeString(`rm: remove directory '${path}'? `);
                if (!await readConfirmation(proc)) return;
            }

            try {
                // ディレクトリ削除は rmdir
                await proc.fs.rmdir(path);
                if (verbose) await writer.writeString(`removed directory '${path}'\n`);
            } catch (e: any) {
                await errWriter.writeString(`rm: cannot remove '${path}': ${e.message}\n`);
                exitCode = 1;
            }

        } else {
            if (interactive) {
                await errWriter.writeString(`rm: remove regular file '${path}'? `);
                if (!await readConfirmation(proc)) return;
            }

            try {
                // ファイル削除は unlink
                await proc.fs.unlink(path);
                if (verbose) await writer.writeString(`removed '${path}'\n`);
            } catch (e: any) {
                await errWriter.writeString(`rm: cannot remove '${path}': ${e.message}\n`);
                exitCode = 1;
            }
        }
    };

    if (parser.args.length === 0) {
        if (!force) {
            await errWriter.writeString("rm: missing operand\n");
            exitCode = 1;
        }
    } else {
        for (const arg of parser.args) {
            await removeNode(arg);
        }
    }

    writer.releaseLock();
    errWriter.releaseLock();
    return exitCode;
}

async function readConfirmation(proc: IProcess): Promise<boolean> {
    if (!proc.stdin) return false;
    const reader = new BinaryReader(proc.stdin.getByteReader());
    try {
        const { value } = await reader.readString();
        const input = value.trim().toLowerCase();
        return input === 'y' || input === 'yes';
    } catch {
        return false;
    } finally {
        reader.releaseLock();
    }
}
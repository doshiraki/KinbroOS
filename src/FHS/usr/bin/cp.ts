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

// src/FHS/usr/bin/cp.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryReader, BinaryWriter } from '../lib/StreamUtils';
import { Stats } from '@zenfs/core';

/**
 * [Command: cp]
 * Copies files and directories.
 * GNU coreutils compliant (Recursive, Backup, Update, Attributes-only supported)
 * Memory-efficient implementation using IFileStream's attach/read API.
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'cp',
        usage: '[OPTION]... [-T] SOURCE DEST\n  or:  cp [OPTION]... SOURCE... DIRECTORY\n  or:  cp [OPTION]... -t DIRECTORY SOURCE...',
        desc: 'Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.',
        options: [
            { short: 'a', long: 'archive', desc: 'same as -dR --preserve=all' },
            { long: 'attributes-only', desc: 'don\'t copy the file data, just the attributes' },
            { long: 'backup', desc: 'make a backup of each existing destination file' },
            { short: 'b', desc: 'like --backup but does not accept an argument' },
            { short: 'd', desc: 'same as --no-dereference --preserve=links' },
            { short: 'f', long: 'force', desc: 'if an existing destination file cannot be opened, remove it and try again' },
            { short: 'i', long: 'interactive', desc: 'prompt before overwrite' },
            { short: 'H', desc: 'follow command-line symbolic links in SOURCE' },
            { short: 'l', long: 'link', desc: 'hard link files instead of copying' },
            { short: 'L', long: 'dereference', desc: 'always follow symbolic links in SOURCE' },
            { short: 'n', long: 'no-clobber', desc: 'do not overwrite an existing file' },
            { short: 'P', long: 'no-dereference', desc: 'never follow symbolic links in SOURCE' },
            { short: 'p', desc: 'same as --preserve=mode,ownership,timestamps' },
            { long: 'preserve', desc: 'preserve the specified attributes' },
            { long: 'parents', desc: 'use full source file name under DIRECTORY' },
            { short: 'R', desc: 'copy directories recursively' },
            { short: 'r', long: 'recursive', desc: 'copy directories recursively' },
            { long: 'remove-destination', desc: 'remove each existing destination file before attempting to open it' },
            { long: 'strip-trailing-slashes', desc: 'remove any trailing slashes from each SOURCE argument' },
            { short: 's', long: 'symbolic-link', desc: 'make symbolic links instead of copying' },
            { short: 'S', long: 'suffix', desc: 'override the usual backup suffix', hasArg: true },
            { short: 't', long: 'target-directory', desc: 'copy all SOURCE arguments into DIRECTORY', hasArg: true },
            { short: 'T', long: 'no-target-directory', desc: 'treat DEST as a normal file' },
            { short: 'u', long: 'update', desc: 'copy only when the SOURCE file is newer than the destination file' },
            { short: 'v', long: 'verbose', desc: 'explain what is being done' },
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    // Display help
    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp() + '\n');
        writer.releaseLock(); errWriter.releaseLock();
        return 0;
    }
    // Argument validation
    if (parser.validate()) {
        await errWriter.writeString(parser.validate() + '\n');
        writer.releaseLock(); errWriter.releaseLock();
        return 1;
    }

    // --- 1. Option parsing and priority resolution ---

    // Archive Mode (-a): Equivalent to -dR --preserve=all
    const isArchive = parser.has('a', 'archive');
    
    // Recursive
    const isRecursive = isArchive || parser.has('r', 'recursive') || parser.has('R');

    // Link Mode (Not supported in OPFS, but flag parsing logic kept)
    const makeSymlink = parser.has('s', 'symbolic-link');
    const makeHardlink = parser.has('l', 'link');

    // Overwrite Control (-n, -i, -f)
    // Last Wins Strategy
    let modeOverwrite = 'force'; // default
    
    // Determine by scanning arguments in reverse order
    for (let i = args.length - 1; i >= 0; i--) {
        const arg = args[i];
        if (arg === '-n' || arg === '--no-clobber') { modeOverwrite = 'no-clobber'; break; }
        if (arg === '-i' || arg === '--interactive') { modeOverwrite = 'interactive'; break; }
        if (arg === '-f' || arg === '--force') { modeOverwrite = 'force'; break; }
    }

    const isUpdate = parser.has('u', 'update');
    const isVerbose = parser.has('v', 'verbose');
    const isAttributesOnly = parser.has(undefined, 'attributes-only');
    const stripSlashes = parser.has(undefined, 'strip-trailing-slashes');
    const preserve = isArchive || parser.has('p') || parser.has(undefined, 'preserve');
    const removeDest = parser.has(undefined, 'remove-destination');

    // Backup Settings
    const isBackup = parser.has('b') || parser.has(undefined, 'backup'); 
    const backupSuffix = (parser.get('suffix') as string) || '~'; 

    // --- 2. Determination of source and destination ---
    let arrSources: string[] = [];
    let strDest: string | null = null;
    let isTargetDirectoryMode = false;

    if (parser.has('t', 'target-directory')) {
        strDest = parser.get('target-directory') as string;
        arrSources = parser.args;
        isTargetDirectoryMode = true;
    } else {
        if (parser.args.length < 2) {
            await errWriter.writeString("cp: missing file operand\n");
            writer.releaseLock(); errWriter.releaseLock();
            return 1;
        }
        strDest = parser.args[parser.args.length - 1];
        arrSources = parser.args.slice(0, -1);
    }

    const noTargetDir = parser.has('T', 'no-target-directory');

    if (stripSlashes) {
        arrSources = arrSources.map(s => s.endsWith('/') && s !== '/' ? s.slice(0, -1) : s);
    }

    // --- 3. Execution of copy process ---
    let exitCode = 0;

    try {
        // Check if target is a directory
        let destIsDir = false;
        if (!noTargetDir && strDest) {
            try {
                const stat = await proc.fs.getStat(strDest);
                if (stat.isDirectory()) destIsDir = true;
            } catch {}
        }

        // Multiple sources -> directory is required
        if (arrSources.length > 1 && !destIsDir && !isTargetDirectoryMode) {
            await errWriter.writeString(`cp: target '${strDest}' is not a directory\n`);
            writer.releaseLock(); errWriter.releaseLock();
            return 1;
        }

        // Copy logic (supports recursion)
        const processCopyItem = async (srcPath: string, destPath: string) => {
            try {
                // Source verification
                const statSrc = await proc.fs.getStat(srcPath);

                if (statSrc.isDirectory()) {
                    // Copy directory
                    if (!isRecursive) {
                        await errWriter.writeString(`cp: -r not specified; omitting directory '${srcPath}'\n`);
                        exitCode = 1;
                        return;
                    }
                    
                    // Create destination directory
                    if (!await proc.fs.exists(destPath)) {
                        await proc.fs.makeDir(destPath);
                        if (isVerbose) await writer.writeString(`created directory '${destPath}'\n`);
                    }

                    // Recursively copy contents
                    const items = await proc.fs.readDir(srcPath);
                    for (const item of items) {
                        await processCopyItem(`${srcPath}/${item}`, `${destPath}/${item}`);
                    }

                    // Preserve directory attributes (-p/-a)
                    if (preserve) {
                         // Execute if IFileSystem has chmod (IFileSystem has chmod)
                         await proc.fs.chmod(destPath, statSrc.mode);
                    }
                } else {
                    // Copy file
                    await copyFile(srcPath, destPath, statSrc);
                }
            } catch (e: any) {
                await errWriter.writeString(`cp: cannot stat '${srcPath}': ${e.message}\n`);
                exitCode = 1;
            }
        };

        // Single file copy logic
        const copyFile = async (src: string, dest: string, statSrc: Stats) => {
            // [Link Mode] Symbolic links / Hard links
            // Unsupported in OPFS, so error or skip
            if (makeSymlink || makeHardlink) {
                 await errWriter.writeString(`cp: links are not supported on this file system\n`);
                 exitCode = 1;
                 return;
            }

            // [Overwrite Logic] If destination exists
            if (await proc.fs.exists(dest)) {
                // -n: No Clobber
                if (modeOverwrite === 'no-clobber') return;

                const statDest = await proc.fs.getStat(dest);

                // -u: Update (Copy only if Source is newer than Dest)
                if (isUpdate && statSrc.mtimeMs <= statDest.mtimeMs) return;

                // -i: Interactive
                if (modeOverwrite === 'interactive') {
                    await errWriter.writeString(`cp: overwrite '${dest}'? (y/n) `);
                    if (!await readConfirmation(proc)) return;
                }

                // --remove-destination
                if (removeDest) {
                    try {
                        await proc.fs.unlink(dest);
                    } catch(e) {}
                }

                // Backup
                if (isBackup) {
                    const backupPath = dest + backupSuffix;
                    try {
                        // Use rename API (assuming it is added to IFileSystem)
                        // Assume IFileSystem.rename exists (similar to mv implementation)
                        await proc.fs.rename(dest, backupPath);
                        if (isVerbose) await writer.writeString(`backed up '${dest}' to '${backupPath}'\n`);
                    } catch (e: any) {
                        await errWriter.writeString(`cp: cannot backup '${dest}': ${e.message}\n`);
                        return;
                    }
                }
            }

            // --attributes-only
            if (isAttributesOnly) {
                if (!await proc.fs.exists(dest)) {
                    await proc.fs.touchFile(dest);
                }
            } else {
                // [Data Copy using IFileStream]
                // 1. Open source
                const fsIn = await proc.fs.open(src, 'r');
                
                // 2. Open target
                // If overwrite, opening with 'w' truncates it
                const fsOut = await proc.fs.open(dest, 'w');

                try {
                    // 3. Attach buffer (Required!)
                    // Not Web Streams, so loop read() after attach()
                    const bufSize = 64 * 1024;
                    const buf = new Uint8Array(bufSize);
                    fsIn.attach(buf);

                    while (true) {
                        // Incremental read
                        const { cntRead, data } = await fsIn.read(); // data is a view to buf
                        if (cntRead === 0) break; // EOF
                        
                        // Write (IFileStream.write has internal buffering \& backpressure control)
                        await fsOut.write(data);
                    }
                } catch (e: any) {
                     await errWriter.writeString(`cp: error writing to '${dest}': ${e.message}\n`);
                     exitCode = 1;
                } finally {
                    // Close (flushed internally)
                    await fsIn.close();
                    await fsOut.close();
                }
            }

            // [Preserve Attributes] -p, -a
            if (preserve) {
                try {
                    // IFileSystem.chmod is already defined
                    await proc.fs.chmod(dest, statSrc.mode);
                    // Skip restoring mtime etc. as IFileSystem lacks utimes
                } catch {}
            }

            if (isVerbose) await writer.writeString(`'${src}' -> '${dest}'\n`);
        };


        // Main loop
        for (const src of arrSources) {
            let finalDest = strDest!;
            // Join filename if copying to a directory
            if (destIsDir) {
                const fileName = src.split('/').pop() || src;
                finalDest = `${strDest}/${fileName}`;
            }
            
            await processCopyItem(src, finalDest);
        }

    } finally {
        writer.releaseLock();
        errWriter.releaseLock();
    }

    return exitCode;
}

/**
 * [Helper] User confirmation
 */
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

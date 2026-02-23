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

// src/FHS/usr/bin/ls.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { CommandParser } from '../lib/CommandParser';
import { BinaryWriter } from '../lib/StreamUtils';
import { Stats } from '@zenfs/core';

interface LsOptions {
    all: boolean;           // -a
    almostAll: boolean;     // -A
    long: boolean;          // -l
    recursive: boolean;     // -R
    humanReadable: boolean; // -h
    directory: boolean;     // -d
    classify: boolean;      // -F
    reverse: boolean;       // -r
    sort: 'name' | 'size' | 'time' | 'none'; // -S, -t, -U
    color: boolean;         // --color
    inode: boolean;         // -i
}

interface FileEntry {
    name: string;
    path: string;
    stats: Stats;
    isDir: boolean;
    isExe: boolean;
    isLink: boolean; // Always false in OPFS, but reserved as a placeholder
}

/**
 * [Command: ls]
 * List directory contents.
 * GNU coreutils compliant (Long format, Recursive, Sorting, Colors)
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'ls',
        usage: '[OPTION]... [FILE]...',
        desc: 'List information about the FILEs (the current directory by default).',
        options: [
            { short: 'a', long: 'all', desc: 'do not ignore entries starting with .' },
            { short: 'A', long: 'almost-all', desc: 'do not list implied . and ..' },
            { short: 'd', long: 'directory', desc: 'list directories themselves, not their contents' },
            { short: 'F', long: 'classify', desc: 'append indicator (one of */=>@|) to entries' },
            { short: 'h', long: 'human-readable', desc: 'with -l and -s, print sizes like 1K 234M 2G' },
            { short: 'i', long: 'inode', desc: 'print the index number of each file' },
            { short: 'l', desc: 'use a long listing format' },
            { short: 'r', long: 'reverse', desc: 'reverse order while sorting' },
            { short: 'R', long: 'recursive', desc: 'list subdirectories recursively' },
            { short: 'S', desc: 'sort by file size, largest first' },
            { short: 't', desc: 'sort by modification time, newest first' },
            { short: 'U', desc: 'do not sort; list entries in directory order' },
            { short: '1', desc: 'list one file per line' },
            { long: 'color', desc: 'colorize the output', hasArg: false }, // Assume no argument or "auto"
            { long: 'help', desc: 'display this help and exit' }
        ]
    });

    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    if (parser.isHelpRequested) {
        await writer.writeString(parser.getHelp() + '\n');
        writer.close(); errWriter.close();
        return 0;
    }

    const opts: LsOptions = {
        all: parser.has('a', 'all'),
        almostAll: parser.has('A', 'almost-all'),
        long: parser.has('l'),
        recursive: parser.has('R', 'recursive'),
        humanReadable: parser.has('h', 'human-readable'),
        directory: parser.has('d', 'directory'),
        classify: parser.has('F', 'classify'),
        reverse: parser.has('r', 'reverse'),
        sort: parser.has('S') ? 'size' : parser.has('t') ? 'time' : parser.has('U') ? 'none' : 'name',
        color: parser.has(undefined, 'color') || (proc.stdout?.isTTY ?? false),
        inode: parser.has('i', 'inode')
    };

    // Default to current directory if no arguments provided
    const targets = parser.args.length > 0 ? parser.args : ['.'];
    
    // Exit code
    let exitCode = 0;

    // Flag to determine whether to display directory headers for multiple targets
    const printDirHeader = targets.length > 1 || opts.recursive;

    try {
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            
            try {
                // Get information for the target itself
                // Note: Use getStat (stat) due to IFileSystem spec, though lstat would be used for symlinks
                const stat = await proc.fs.getStat(target);
                const isDir = stat.isDirectory();

                if (isDir && !opts.directory) {
                    // Display directory contents
                    if (printDirHeader) {
                        // Insert newline for second target onwards or during recursion
                        if (i > 0) await writer.writeString('\n');
                        await writer.writeString(`${target}:\n`);
                    }
                    await listDirectory(target, writer, proc, opts);
                } else {
                    // Display the file itself (or directory if -d is specified)
                    // Convert to Entry to format and display as a file list
                    const entry = await createEntry(proc, ".", target); // Parent is a dummy
                    if (entry) {
                        // Logic for single item display (shared format)
                        await printEntries([entry], writer, opts);
                    }
                }
            } catch (e: any) {
                await errWriter.writeString(`ls: cannot access '${target}': No such file or directory\n`);
                exitCode = 1;
            }
        }
    } finally {
        writer.close();
        errWriter.close();
    }

    return exitCode;
}

// --- Logic ---

/**
 * Lists and displays directory contents (recursive support)
 */
async function listDirectory(pathDir: string, writer: BinaryWriter, proc: IProcess, opts: LsOptions) {
    let names: string[] = [];
    try {
        names = await proc.fs.readDir(pathDir);
    } catch (e: any) {
        await writer.writeString(`ls: cannot open directory '${pathDir}': ${e.message}\n`);
        return;
    }

    // Collect entry information
    const entries: FileEntry[] = [];
    for (const name of names) {
        // -a / -A filtering
        if (name.startsWith('.')) {
            if (!opts.all && !opts.almostAll) continue;
            if (opts.almostAll && (name === '.' || name === '..')) continue;
        }
        
        const entry = await createEntry(proc, pathDir, name);
        if (entry) entries.push(entry);
    }

    // Sorting
    sortEntries(entries, opts);

    // Display
    await printEntries(entries, writer, opts);

    // Recursive processing (-R)
    if (opts.recursive) {
        for (const entry of entries) {
            if (entry.isDir && entry.name !== '.' && entry.name !== '..') {
                await writer.writeString(`\n${entry.path}:\n`);
                await listDirectory(entry.path, writer, proc, opts);
            }
        }
    }
}

async function createEntry(proc: IProcess, parentDir: string, name: string): Promise<FileEntry | null> {
    const fullPath = parentDir === '.' ? name : (parentDir.endsWith('/') ? parentDir + name : parentDir + '/' + name);
    try {
        const stat = await proc.fs.getStat(fullPath);
        return {
            name: name,
            path: fullPath,
            stats: stat,
            isDir: stat.isDirectory(),
            isExe: (stat.mode & 0o111) !== 0 && !stat.isDirectory(), // Executable check (simple)
            isLink: stat.isSymbolicLink()
        };
    } catch {
        return null; // Ignore files that no longer exist
    }
}

function sortEntries(entries: FileEntry[], opts: LsOptions) {
    if (opts.sort === 'none') return;

    entries.sort((a, b) => {
        let cmp = 0;
        switch (opts.sort) {
            case 'size': cmp = b.stats.size - a.stats.size; break; // Largest first
            case 'time': cmp = b.stats.mtimeMs - a.stats.mtimeMs; break; // Newest first
            case 'name': cmp = a.name.localeCompare(b.name); break;
        }
        return opts.reverse ? -cmp : cmp;
    });
}

async function printEntries(entries: FileEntry[], writer: BinaryWriter, opts: LsOptions) {
    if (entries.length === 0) return;

    if (opts.long) {
        // Long Format Output (-l)
        const totalBlocks = entries.reduce((acc, e) => acc + Math.ceil(e.stats.size / 512), 0); // Simple block calculation
        if (entries.length > 0 && !opts.directory) { // Generally, "total" is not shown with -d
             await writer.writeString(`total ${totalBlocks}\n`);
        }

        for (const e of entries) {
            const meta = formatLongMeta(e, opts);
            const name = formatName(e, opts);
            await writer.writeString(`${meta} ${name}\n`);
        }
    } else {
        // Short Format (Single entry per line. Column display is ideal, but simplified for now)
        for (const e of entries) {
            const name = formatName(e, opts);
            await writer.writeString(`${name}\n`);
        }
    }
}

// --- Formatting Helpers ---

function formatName(e: FileEntry, opts: LsOptions): string {
    let name = e.name;
    
    // Colorize
    if (opts.color) {
        if (e.isDir) name = `\x1b[1;34m${name}\x1b[0m`; // Blue Bold
        else if (e.isLink) name = `\x1b[1;36m${name}\x1b[0m`; // Cyan Bold
        else if (e.isExe) name = `\x1b[1;32m${name}\x1b[0m`; // Green Bold
    }

    // Classify (-F)
    if (opts.classify) {
        if (e.isDir) name += '/';
        else if (e.isLink) name += '@';
        else if (e.isExe) name += '*';
    }

    // -i
    if (opts.inode) {
        name = `${e.stats.ino} ${name}`;
    }

    return name;
}

function formatLongMeta(e: FileEntry, opts: LsOptions): string {
    const s = e.stats;
    
    // Mode string (drwxr-xr-x)
    const type = e.isDir ? 'd' : (e.isLink ? 'l' : '-');
    const perm = (mode: number) => {
        return (mode & 4 ? 'r' : '-') + (mode & 2 ? 'w' : '-') + (mode & 1 ? 'x' : '-');
    };
    // Assume ZenFS mode uses standard Unix mode bits
    const u = perm((s.mode >> 6) & 7);
    const g = perm((s.mode >> 3) & 7);
    const o = perm(s.mode & 7);
    const strMode = `${type}${u}${g}${o}`;

    // Links (Hardcoded 1 or 2 for dirs if not available)
    const nlink = (s as any).nlink || (e.isDir ? 2 : 1);

    // User/Group (Default to "geek" or IDs as ZenFS often only provides IDs)
    const user = 'geek'; 
    const group = 'geek';

    // Size
    let strSize = String(s.size);
    if (opts.humanReadable) {
        strSize = formatSize(s.size);
    }

    // Time
    const date = new Date(s.mtimeMs);
    const strDate = date.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    // Note: Standard ls shows the year if the file is more than six months old

    // Padding (Should ideally match max width of all entries, but simplified for now)
    // Formatting with spaces instead of tabs here
    return `${strMode} ${String(nlink).padStart(2)} ${user} ${group} ${strSize.padStart(opts.humanReadable?5:8)} ${strDate}`;
}

function formatSize(bytes: number): string {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    return bytes.toFixed(1).replace(/\.0$/, '') + units[i];
}

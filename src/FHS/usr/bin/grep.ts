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

import { CommandParser } from '../lib/CommandParser';
import { SystemAPI } from '@/dev/types/SystemAPI';
import { IProcess } from '@/dev/types/IProcess';

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const writer = proc.stdout!.getStringWriter();
    const stderr = proc.stderr!.getStringWriter();

    const safeWrite = async (str: string) => {
        try { await writer.write(str); } catch (e) { throw new Error("EPIPE"); }
    };

    // 1. 引数定義 (grep.txt に基づき完全網羅)
    const parser = new CommandParser(args, {
        name: 'grep',
        usage: '[OPTION]... PATTERNS [FILE]...',
        desc: 'Search for PATTERNS in each FILE.',
        options: [
            // Pattern selection
            { short: 'E', long: 'extended-regexp', desc: 'PATTERNS are extended regular expressions' }, // JS Default
            { short: 'F', long: 'fixed-strings', desc: 'PATTERNS are strings' },
            { short: 'G', long: 'basic-regexp', desc: 'PATTERNS are basic regular expressions' }, // Treated as extended
            { short: 'P', long: 'perl-regexp', desc: 'PATTERNS are Perl regular expressions' }, // Treated as extended
            { short: 'e', long: 'regexp', hasArg: true, desc: 'use PATTERNS for matching' },
            { short: 'f', long: 'file', hasArg: true, desc: 'take PATTERNS from FILE' },
            { short: 'i', long: 'ignore-case', desc: 'ignore case distinctions' },
            { long: 'no-ignore-case', desc: 'do not ignore case distinctions' },
            { short: 'w', long: 'word-regexp', desc: 'match only whole words' },
            { short: 'x', long: 'line-regexp', desc: 'match only whole lines' },
            { short: 'z', long: 'null-data', desc: 'a data line ends in 0 byte, not newline' },

            // Misc
            { short: 's', long: 'no-messages', desc: 'suppress error messages' },
            { short: 'v', long: 'invert-match', desc: 'select non-matching lines' },
            { short: 'V', long: 'version', desc: 'print version information and exit' },
            { long: 'help', desc: 'display this help and exit' },

            // Output control
            { short: 'm', long: 'max-count', hasArg: true, desc: 'stop after NUM selected lines' },
            { short: 'b', long: 'byte-offset', desc: 'print the byte offset with output lines' },
            { short: 'n', long: 'line-number', desc: 'print line number with output lines' },
            { long: 'line-buffered', desc: 'flush output on every line' },
            { short: 'H', long: 'with-filename', desc: 'print file name with output lines' },
            { short: 'h', long: 'no-filename', desc: 'suppress the file name prefix on output' },
            { long: 'label', hasArg: true, desc: 'use LABEL as the standard input file name prefix' },
            { short: 'o', long: 'only-matching', desc: 'show only nonempty parts of lines that match' },
            { short: 'q', long: 'quiet', desc: 'suppress all normal output' },
            { long: 'silent', desc: 'same as --quiet' },
            { long: 'binary-files', hasArg: true, desc: 'assume that binary files are TYPE' },
            { short: 'a', long: 'text', desc: 'equivalent to --binary-files=text' },
            { short: 'I', desc: 'equivalent to --binary-files=without-match' },
            { short: 'd', long: 'directories', hasArg: true, desc: 'action for directories' },
            { short: 'D', long: 'devices', hasArg: true, desc: 'action for devices, FIFOs and sockets' },
            { short: 'r', long: 'recursive', desc: 'like --directories=recurse' },
            { short: 'R', long: 'dereference-recursive', desc: 'likewise, but follow all symlinks' },
            { long: 'include', hasArg: true, desc: 'search only files that match GLOB' },
            { long: 'exclude', hasArg: true, desc: 'skip files that match GLOB' },
            { long: 'exclude-from', hasArg: true, desc: 'skip files that match any file pattern from FILE' },
            { long: 'exclude-dir', hasArg: true, desc: 'skip directories that match GLOB' },
            { short: 'L', long: 'files-without-match', desc: 'print only names of FILEs with no selected lines' },
            { short: 'l', long: 'files-with-matches', desc: 'print only names of FILEs with selected lines' },
            { short: 'c', long: 'count', desc: 'print only a count of selected lines per FILE' },
            { short: 'T', long: 'initial-tab', desc: 'make tabs line up (if needed)' },
            { short: 'Z', long: 'null', desc: 'print 0 byte after FILE name' },

            // Context control
            { short: 'B', long: 'before-context', hasArg: true, desc: 'print NUM lines of leading context' },
            { short: 'A', long: 'after-context', hasArg: true, desc: 'print NUM lines of trailing context' },
            { short: 'C', long: 'context', hasArg: true, desc: 'print NUM lines of output context' },
            { long: 'group-separator', hasArg: true, desc: 'print SEP on line between matches with context' },
            { long: 'no-group-separator', desc: 'do not print separator for matches with context' },
            { long: 'color', hasArg: true, desc: 'use markers to highlight the matching strings' },
            { long: 'colour', hasArg: true, desc: 'alias for --color' },
            { short: 'U', long: 'binary', desc: 'do not strip CR characters at EOL' }
        ]
    });

    if (parser.isHelpRequested) {
        await writer.write(parser.getHelp() + '\r\n');
        await writer.close();
        return 0;
    }
    if (parser.has('V', 'version')) {
        await writer.write('grep (KinbroOS) 2.0\r\n');
        await writer.close();
        return 0;
    }

    // --- Helper Functions ---
    const getArgValues = (key: string): string[] => {
        const val = parser.get(key);
        if (Array.isArray(val)) return val;
        if (typeof val === 'string') return [val];
        return [];
    };
    const getLastArg = (key: string): string | undefined => {
        const vals = getArgValues(key);
        return vals.length > 0 ? vals[vals.length - 1] : undefined;
    };
    const globToRegex = (glob: string): RegExp => {
        // Simple glob to regex conversion
        const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${pattern}$`);
    };

    // 2. パターン構築
    let patterns: string[] = [];
    
    // -e PATTERN
    patterns.push(...getArgValues('e'));

    // -f FILE
    const patternFiles = getArgValues('f');
    for (const f of patternFiles) {
        try {
            const content = await proc.fs.readFile(f, 'utf8') as string;
            // 空行は全てにマッチしてしまうので注意が必要だが、GNU grepは空行もパターンとする
            patterns.push(...content.split('\n').filter(l => l.length > 0)); 
        } catch (e: any) {
            if (!parser.has('s')) await stderr.write(`grep: ${f}: No such file or directory\r\n`);
            await stderr.close(); return 2;
        }
    }

    let targetArgs = parser.args;
    if (patterns.length === 0 && targetArgs.length > 0) {
        // オプションでパターン指定がない場合、最初の引数をパターンとする
        patterns.push(targetArgs[0]);
        targetArgs = targetArgs.slice(1);
    } else if (patterns.length === 0) {
        await stderr.write('grep: usage: grep [OPTION]... PATTERNS [FILE]...\r\n');
        await stderr.close(); return 2;
    }

    // パターン結合
    let combinedPattern = patterns.join('|');
    if (parser.has('F')) combinedPattern = patterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (parser.has('w')) combinedPattern = patterns.map(p => `\\b${p}\\b`).join('|');
    if (parser.has('x')) combinedPattern = patterns.map(p => `^${p}$`).join('|');

    let regexp: RegExp;
    try {
        const flags = parser.has('i') ? 'gi' : 'g';
        regexp = new RegExp(combinedPattern, flags);
    } catch (e: any) {
        await stderr.write(`grep: invalid regex: ${e.message}\r\n`);
        await stderr.close(); return 2;
    }

    // 3. 設定値の解決
    if (targetArgs.length === 0) targetArgs = ['-'];

    const opts = {
        invert: parser.has('v'),
        count: parser.has('c'),
        filesWithMatch: parser.has('l'),
        filesWithoutMatch: parser.has('L'),
        lineNum: parser.has('n'),
        byteOffset: parser.has('b'),
        quiet: parser.has('q') || parser.has('silent'),
        noMessages: parser.has('s'),
        recursive: parser.has('r') || parser.has('R'),
        onlyMatching: parser.has('o'),
        nullData: parser.has('z'),
        nullOutput: parser.has('Z'),
        initialTab: parser.has('T'),
        maxCount: parseInt(getLastArg('m') || '-1'),
        binaryFiles: getLastArg('binary-files') || (parser.has('a') ? 'text' : (parser.has('I') ? 'without-match' : 'binary')),
        devices: getLastArg('D') || 'read',
        directories: getLastArg('d') || (parser.has('r') || parser.has('R') ? 'recurse' : 'read'),
        color: getLastArg('color') || getLastArg('colour') || (parser.has('color') ? 'auto' : 'never'),
        label: getLastArg('label'),
        ctxBefore: parseInt(getLastArg('B') || getLastArg('C') || '0'),
        ctxAfter: parseInt(getLastArg('A') || getLastArg('C') || '0'),
        groupSep: getLastArg('group-separator') || (parser.has('no-group-separator') ? null : '--'),
    };
    
    // カラー設定 (autoの場合TTY判定)
    const useColor = (opts.color === 'always') || (opts.color === 'auto' && (proc.stdout?.isTTY ?? false));
    
    // Glob設定
    const includes = getArgValues('include').map(globToRegex);
    const excludes = getArgValues('exclude').map(globToRegex);
    const excludeDirs = getArgValues('exclude-dir').map(globToRegex);
    // exclude-from は実装省略 (ファイル読み込みが必要なため)

    // ファイル名表示判定
    let showFilename = parser.has('H');
    if (parser.has('h')) showFilename = false;
    else if (!showFilename && (opts.recursive || targetArgs.length > 1)) showFilename = true;

    // 4. ファイル探索 & 処理キュー
    let totalMatches = 0;
    const queue = [...targetArgs];
    
    try {
        while (queue.length > 0) {
            const path = queue.shift()!;
            
            // 除外チェック (ディレクトリかファイルかわからない段階だが、名前でチェック)
            const basename = path.split('/').pop() || path;
            if (path !== '-' && excludes.some(r => r.test(basename))) continue;
            
            let isDir = false;
            if (path !== '-') {
                try {
                    const stat = await proc.fs.getStat(path);
                    isDir = stat.isDirectory();
                } catch {
                    if (!opts.noMessages) await stderr.write(`grep: ${path}: No such file or directory\r\n`);
                    continue;
                }
            }

            if (isDir) {
                if (opts.directories === 'skip') continue;
                if (opts.directories === 'read') {
                    if (!opts.noMessages) await stderr.write(`grep: ${path}: Is a directory\r\n`);
                    continue;
                }
                if (opts.directories === 'recurse') {
                    if (excludeDirs.some(r => r.test(basename))) continue;
                    const children = await proc.fs.readDir(path);
                    for (const child of children) {
                        if (child === '.' || child === '..') continue;
                        const separator = path.endsWith('/') ? '' : '/';
                        queue.push(`${path}${separator}${child}`);
                    }
                }
                continue;
            } else {
                // ファイルの場合、Includeチェック
                if (path !== '-' && includes.length > 0 && !includes.some(r => r.test(basename))) continue;
            }

            // --- ファイル処理実行 ---
            const displayPath = (path === '-' && opts.label) ? opts.label : path;
            const matches = await processFile(path, displayPath, regexp, opts, showFilename, useColor, proc, safeWrite);
            if (matches > 0) totalMatches += matches;
            
            // -q でマッチしたら即終了
            if (opts.quiet && totalMatches > 0) return 0;
        }
    } catch (e: any) {
        if (e.message !== 'EPIPE') { /* console.error(e); */ }
    } finally {
        await writer.close();
        await stderr.close();
    }

    return totalMatches > 0 ? 0 : 1;
}

// 5. ファイル処理コアロジック (ストリーミング + コンテキスト)
async function processFile(
    realPath: string,
    displayPath: string,
    regexp: RegExp,
    opts: any,
    showFilename: boolean,
    useColor: boolean,
    proc: IProcess,
    write: (s: string) => Promise<void>
): Promise<number> {
    
    // --- Stream Setup ---
    let lineReader: AsyncIterableIterator<string>;
    if (realPath === '-') {
        if (!proc.stdin) return 0;
        lineReader = createLineReader(proc.stdin.getStringReader(), opts.nullData ? '\0' : '\n');
    } else {
        // Binary File Check (簡易: 先頭バイト等で判定すべきだが、今回は拡張子やオプションに従う)
        // opts.binaryFiles === 'without-match' (-I) ならスキップすべきだが、読み込まないとわからない
        // ここではテキストとして読み込む
        try {
            const content = await proc.fs.readFile(realPath, 'utf8') as string;
            // メモリ効率は悪いが簡易実装としてsplit
            const sep = opts.nullData ? '\0' : '\n';
            lineReader = (async function*() { 
                for(const l of content.split(sep)) yield l; 
            })();
        } catch {
            return 0; // エラーはメインループで処理済み想定
        }
    }

    let matchCount = 0;
    let lineNum = 0;
    let byteOffset = 0;
    const encoder = new TextEncoder();

    // Context Buffers
    const bufferBefore: {line: string, num: number}[] = [];
    let linesToPrintAfter = 0;
    let hasPrintedGroupSep = false;
    let lastMatchLineNum = -1;

    for await (let line of lineReader) {
        // 末尾のCR除去 (-U指定なければ)
        if (!opts.nullData && !opts.binary && line.endsWith('\r')) line = line.slice(0, -1);
        
        lineNum++;
        const currentByteOffset = byteOffset;
        byteOffset += encoder.encode(line + (opts.nullData ? '\0' : '\n')).length;

        regexp.lastIndex = 0;
        const isMatchRaw = regexp.test(line);
        const isHit = opts.invert ? !isMatchRaw : isMatchRaw;

        if (isHit) {
            matchCount++;
            
            // 即時終了系
            if (opts.quiet) return 1; // マッチ数1以上確定
            if (opts.filesWithoutMatch) return 0; // マッチした時点で除外
            if (opts.filesWithMatch) {
                await write(`${displayPath}${opts.nullOutput ? '\0' : '\n'}`);
                return 1; // これ以上読む必要なし
            }
            if (opts.count) continue; // カウントのみ

            // Group Separator
            if (opts.groupSep && lastMatchLineNum !== -1 && lineNum > lastMatchLineNum + 1 && (opts.ctxBefore > 0 || opts.ctxAfter > 0)) {
                await write(`${opts.groupSep}\n`);
            }
            lastMatchLineNum = lineNum + opts.ctxAfter;

            // Print Before Context
            while (bufferBefore.length > 0) {
                const prev = bufferBefore.shift()!;
                await printLine(prev.line, prev.num, displayPath, '-', showFilename, opts, useColor, null, write);
            }

            // Print Match
            if (opts.onlyMatching && !opts.invert) {
                const matches = line.match(regexp);
                if (matches) {
                    for (const m of matches) await write(m + '\n');
                }
            } else {
                await printLine(line, lineNum, displayPath, ':', showFilename, opts, useColor, regexp, write);
            }

            linesToPrintAfter = opts.ctxAfter;

            // Max Count Check
            if (opts.maxCount > 0 && matchCount >= opts.maxCount) break;

        } else {
            // No Match
            if (linesToPrintAfter > 0) {
                // Print After Context
                if (!opts.count && !opts.filesWithMatch && !opts.filesWithoutMatch) {
                     await printLine(line, lineNum, displayPath, '-', showFilename, opts, useColor, null, write);
                }
                linesToPrintAfter--;
            } else {
                // Store for Before Context
                if (opts.ctxBefore > 0) {
                    bufferBefore.push({line, num: lineNum});
                    if (bufferBefore.length > opts.ctxBefore) bufferBefore.shift();
                }
            }
        }
    }

    // Post-file Output
    if (opts.count && !opts.quiet) {
        if (showFilename) await write(`${displayPath}:`);
        await write(`${matchCount}\n`);
    }
    if (opts.filesWithoutMatch && matchCount === 0) {
        await write(`${displayPath}${opts.nullOutput ? '\0' : '\n'}`);
    }

    return matchCount;
}

// 6. 出力フォーマッタ
async function printLine(
    line: string,
    lineNum: number,
    path: string,
    sep: string, // ':' or '-'
    showName: boolean,
    opts: any,
    useColor: boolean,
    regexp: RegExp | null,
    write: (s: string) => Promise<void>
) {
    // Initial Tab (-T)
    if (opts.initialTab) await write('\t');

    // Filename
    if (showName) {
        const p = useColor ? `\x1b[35m${path}\x1b[0m` : path;
        await write(p + (opts.nullOutput ? '\0' : `\x1b[36m${sep}\x1b[0m`));
    }

    // Line Number
    if (opts.lineNum) {
        const n = useColor ? `\x1b[32m${lineNum}\x1b[0m` : lineNum.toString();
        await write(n + `\x1b[36m${sep}\x1b[0m`);
    }

    // Byte Offset
    if (opts.byteOffset) {
        // Note: Correct byte offset calculation requires tracking globally, which is done in main loop
        // Here we just skip specific display implementation for brevity or print simplistic
    }

    // Content
    let content = line;
    if (useColor && regexp) {
        regexp.lastIndex = 0;
        content = line.replace(regexp, (m) => `\x1b[1;31m${m}\x1b[0m`);
    }
    await write(content + '\n');
}

// 7. ストリーミングリーダー
async function* createLineReader(reader: ReadableStreamDefaultReader<string>, delimiter: string) {
    let buffer = '';
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let index: number;
            while ((index = buffer.indexOf(delimiter)) !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + delimiter.length);
                yield line;
            }
        }
        if (buffer.length > 0) yield buffer;
    } finally {
        reader.releaseLock();
    }
}
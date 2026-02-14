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

// src/FHS/usr/bin/find.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { BinaryWriter } from '../lib/StreamUtils';
import { Stats } from '@zenfs/core';

/**
 * [Type Definitions]
 */
interface FindContext {
    path: string;      // 現在処理中のパス
    name: string;      // ファイル名
    stats: Stats;      // ファイル情報
    depth: number;     // 深さ
}

// 評価関数の型
type Predicate = (ctx: FindContext) => Promise<boolean>;

/**
 * [Command: find]
 * ディレクトリ階層を検索し、条件に一致するファイルに対してアクションを実行する。
 * GNU findutils 準拠 (-ls Action Supported)
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());

    // 1. 簡易ヘルプチェック
    if (args.includes('--help')) {
        await writer.writeString(getHelp());
        writer.close();
        errWriter.close();
        return 0;
    }

    // 2. 引数の解析 (パス部分 と 式部分 の分離)
    const paths: string[] = [];
    let expressionArgs: string[] = [];
    
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('-') && isKnownOption(arg)) {
            break; // ここから式
        }
        if (arg === '(' || arg === '!') {
            break; // ここから式
        }
        paths.push(arg);
    }
    expressionArgs = args.slice(i);

    if (paths.length === 0) {
        paths.push('.');
    }

    // 3. 評価ツリーの構築
    let rootPredicate: Predicate;
    try {
        rootPredicate = buildExpressionTree(expressionArgs, sys, proc, writer);
    } catch (e: any) {
        await errWriter.writeString(`find: ${e.message}\n`);
        return 1;
    }

    // 4. トラバーサル実行
    let exitCode = 0;
    for (const rootPath of paths) {
        try {
            await walk(rootPath, 0, rootPredicate, sys, proc, errWriter);
        } catch (e: any) {
            await errWriter.writeString(`find: '${rootPath}': ${e.message}\n`);
            exitCode = 1;
        }
    }

    writer.close();
    errWriter.close();
    return exitCode;
}

// --- Expression Parser Logic ---

function isKnownOption(arg: string): boolean {
    const known = [
        '-name', '-iname', '-type', '-size', '-mtime', '-empty', 
        '-print', '-print0', '-delete', '-exec', '-ls', // -ls [cite: 58]
        '-o', '-or', '-a', '-and', '-not'
    ];
    return known.includes(arg);
}

function buildExpressionTree(tokens: string[], sys: SystemAPI, proc: IProcess, writer: BinaryWriter): Predicate {
    // 省略時アクション: アクションがなければ -print を付与
    const hasAction = tokens.some(t => ['-print', '-print0', '-delete', '-exec', '-ls'].includes(t));
    
    const tokenQueue = [...tokens];
    if (!hasAction) {
        tokenQueue.push('-print');
    }

    let cursor = 0;

    const parseExpression = (): Predicate => {
        let left = parseTerm();
        while (cursor < tokenQueue.length) {
            if (tokenQueue[cursor] === '-o' || tokenQueue[cursor] === '-or') {
                cursor++;
                const right = parseTerm();
                const prevLeft = left; 
                left = async (ctx) => (await prevLeft(ctx)) || (await right(ctx));
            } else if (tokenQueue[cursor] === ')') {
                break; 
            } else {
                break;
            }
        }
        return left;
    };

    const parseTerm = (): Predicate => {
        let left = parseFactor();
        while (cursor < tokenQueue.length) {
            const token = tokenQueue[cursor];
            if (token === '-a' || token === '-and') {
                cursor++;
                const right = parseFactor();
                const prevLeft = left;
                left = async (ctx) => (await prevLeft(ctx)) && (await right(ctx));
            } else if (token === '-o' || token === '-or' || token === ')') {
                break; 
            } else {
                // Implicit AND
                const right = parseFactor();
                const prevLeft = left;
                left = async (ctx) => (await prevLeft(ctx)) && (await right(ctx));
            }
        }
        return left;
    };

    const parseFactor = (): Predicate => {
        if (cursor >= tokenQueue.length) return async () => true;

        const token = tokenQueue[cursor++];

        if (token === '(') {
            const expr = parseExpression();
            if (tokenQueue[cursor] !== ')') throw new Error("unmatched '('");
            cursor++;
            return expr;
        }

        if (token === '!' || token === '-not') {
            const factor = parseFactor();
            return async (ctx) => !(await factor(ctx));
        }

        return createTestOrAction(token, sys, proc, writer);
    };

    const createTestOrAction = (token: string, sys: SystemAPI, proc: IProcess, writer: BinaryWriter): Predicate => {
        // --- Tests ---
        if (token === '-name' || token === '-iname') {
            const pattern = nextToken();
            const regex = globToRegex(pattern, token === '-iname');
            return async (ctx) => regex.test(ctx.name);
        }
        if (token === '-type') {
            const typeChar = nextToken(); 
            return async (ctx) => {
                if (typeChar === 'f') return ctx.stats.isFile();
                if (typeChar === 'd') return ctx.stats.isDirectory();
                if (typeChar === 'l') return ctx.stats.isSymbolicLink();
                return false;
            };
        }
        if (token === '-empty') {
            return async (ctx) => {
                if (ctx.stats.isDirectory()) {
                    try {
                        const entries = await proc.fs.readDir(ctx.path);
                        return entries.length === 0;
                    } catch { return false; }
                }
                return ctx.stats.size === 0;
            };
        }
        if (token === '-size') {
            const arg = nextToken();
            const { size, op } = parseSize(arg);
            return async (ctx) => compareNum(ctx.stats.size, size, op);
        }
        if (token === '-mtime') {
            const arg = nextToken();
            const { val, op } = parseNum(arg);
            return async (ctx) => {
                const days = (Date.now() - ctx.stats.mtimeMs) / (1000 * 60 * 60 * 24);
                return compareNum(Math.floor(days), val, op);
            };
        }

        // --- Actions ---
        if (token === '-print') {
            return async (ctx) => {
                await writer.writeString(ctx.path + '\n');
                return true; 
            };
        }
        if (token === '-print0') {
            return async (ctx) => {
                await writer.writeString(ctx.path + '\0');
                return true;
            };
        }
        // ✨ -ls Action [cite: 58]
        if (token === '-ls') {
            return async (ctx) => {
                const line = formatLs(ctx);
                await writer.writeString(line + '\n');
                return true;
            };
        }
        if (token === '-delete') {
            return async (ctx) => {
                try {
                    if (ctx.name === '.' || ctx.name === '..') return false;
                    if (ctx.stats.isDirectory()) {
                        await proc.fs.rmdir(ctx.path);
                    } else {
                        await proc.fs.unlink(ctx.path);
                    }
                    return true;
                } catch (e: any) {
                    await writer.writeString(`find: cannot delete '${ctx.path}': ${e.message}\n`);
                    return false;
                }
            };
        }
        if (token === '-exec') {
            const commandParts: string[] = [];
            while (cursor < tokenQueue.length) {
                const t = tokenQueue[cursor++];
                if (t === ';') break;
                commandParts.push(t);
            }
            return async (ctx) => {
                const execArgs = commandParts.map(arg => arg.replace('{}', ctx.path));
                if (execArgs.length === 0) return true;
                const cmd = execArgs[0];
                const args = execArgs.slice(1);
                try {
                    const code = await sys.execPath(proc, cmd, args, true);
                    return code === 0;
                } catch (e) {
                    return false;
                }
            };
        }

        throw new Error(`unknown predicate '${token}'`);
    };

    const nextToken = () => {
        if (cursor >= tokenQueue.length) throw new Error("missing argument");
        return tokenQueue[cursor++];
    };

    return parseExpression();
}

// --- Traversal Logic ---

async function walk(
    currentPath: string, 
    depth: number, 
    predicate: Predicate, 
    sys: SystemAPI, 
    proc: IProcess,
    errWriter: BinaryWriter
) {
    let stats: Stats;
    try {
        stats = await proc.fs.lstat(currentPath);
    } catch (e) {
        await errWriter.writeString(`find: '${currentPath}': No such file or directory\n`);
        return;
    }

    const name = currentPath.split('/').pop() || currentPath;
    const ctx: FindContext = { path: currentPath, name, stats, depth };

    await predicate(ctx);

    if (stats.isDirectory()) {
        let children: string[] = [];
        try {
            children = await proc.fs.readDir(currentPath);
        } catch (e: any) {
            await errWriter.writeString(`find: '${currentPath}': ${e.message}\n`);
            return;
        }

        for (const child of children) {
            if (child === '.' || child === '..') continue;
            const childPath = currentPath.endsWith('/') ? `${currentPath}${child}` : `${currentPath}/${child}`;
            await walk(childPath, depth + 1, predicate, sys, proc, errWriter);
        }
    }
}

// --- Helpers ---

/**
 * ✨ -ls 用のフォーマッター
 * format: inode blocks perms links user group size date name
 */
function formatLs(ctx: FindContext): string {
    const s = ctx.stats;
    
    // Inode
    const ino = String(s.ino).padStart(6);
    
    // Blocks (1KB units, approximate)
    const blocks = String(Math.ceil(s.size / 1024)).padStart(4);

    // Perms
    const isDir = s.isDirectory();
    const isLink = s.isSymbolicLink();
    const type = isDir ? 'd' : (isLink ? 'l' : '-');
    const perm = (mode: number) => (mode & 4 ? 'r' : '-') + (mode & 2 ? 'w' : '-') + (mode & 1 ? 'x' : '-');
    const modeStr = type + perm((s.mode >> 6) & 7) + perm((s.mode >> 3) & 7) + perm(s.mode & 7);

    // Links
    const nlink = String((s as any).nlink || (isDir ? 2 : 1)).padStart(3);

    // User/Group
    const user = 'geek';
    const group = 'geek';

    // Size
    const size = String(s.size).padStart(8);

    // Time
    const date = new Date(s.mtimeMs);
    const dateStr = date.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

    return `${ino} ${blocks} ${modeStr} ${nlink} ${user} ${group} ${size} ${dateStr} ${ctx.path}`;
}

function globToRegex(glob: string, ignoreCase: boolean): RegExp {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const pattern = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(pattern, ignoreCase ? 'i' : '');
}

function parseNum(arg: string): { val: number, op: 'gt' | 'lt' | 'eq' } {
    if (arg.startsWith('+')) return { val: parseInt(arg.slice(1)), op: 'gt' };
    if (arg.startsWith('-')) return { val: parseInt(arg.slice(1)), op: 'lt' };
    return { val: parseInt(arg), op: 'eq' };
}

function compareNum(actual: number, target: number, op: 'gt' | 'lt' | 'eq'): boolean {
    if (op === 'gt') return actual > target;
    if (op === 'lt') return actual < target;
    return actual === target;
}

function parseSize(arg: string): { size: number, op: 'gt' | 'lt' | 'eq' } {
    const suffix = arg.slice(-1).toLowerCase();
    let numStr = arg;
    let multiplier = 512; // Default "b"

    if (['c', 'w', 'k', 'm', 'g'].includes(suffix)) {
        numStr = arg.slice(0, -1);
        switch (suffix) {
            case 'c': multiplier = 1; break;
            case 'w': multiplier = 2; break;
            case 'k': multiplier = 1024; break;
            case 'm': multiplier = 1024 * 1024; break;
            case 'g': multiplier = 1024 * 1024 * 1024; break;
        }
    } else {
        if (suffix === 'b') numStr = arg.slice(0, -1);
    }

    const { val, op } = parseNum(numStr);
    return { size: val * multiplier, op };
}

function getHelp(): string {
    return `Usage: find [path...] [expression]

default path is the current directory; default expression is -print
expression may consist of: operators, options, tests, and actions:

operators (decreasing precedence; -and is implicit where no others are given):
      ( EXPR )   ! EXPR   -not EXPR   EXPR1 -a EXPR2   EXPR1 -and EXPR2
      EXPR1 -o EXPR2   EXPR1 -or EXPR2

tests (N can be +N or -N or N):
      -name PATTERN  -iname PATTERN
      -type [f|d|l]
      -size N[cwbkMG]
      -mtime N (days)
      -empty

actions:
      -print   -print0   -ls
      -delete
      -exec COMMAND ;
`;
}
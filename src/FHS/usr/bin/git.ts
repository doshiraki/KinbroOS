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
import { IProcess, StreamData } from '../../../dev/types/IProcess';
import { CommandParser, CommandDef } from '../lib/CommandParser'; 
import { BinaryWriter } from '../lib/StreamUtils';

import git from 'isomorphic-git';
import { Buffer } from 'buffer';

// Polyfill for isomorphic-git in browser environment
if (!globalThis.Buffer) { (globalThis as any).Buffer = Buffer; }

// ==========================================
// Constants & Types
// ==========================================

const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface GitContext {
    fs: any;           // Raw FS Backend
    proc: IProcess;    // Process Context
    sys: SystemAPI;    // System API
    writer: BinaryWriter;
    errWriter: BinaryWriter;
    
    // Repository Context
    repoRoot: string;  // Repository Root (e.g., "/")
    cwd: string;       // Current Working Directory (e.g., "/src")
    prefix: string;    // Relative path from Root to CWD (e.g., "src")
}

interface DiffOptions {
    useColor: boolean;
    nameOnly?: boolean;
    cached?: boolean; // If true, allows comparison against non-worktree items
}

// ==========================================
// Command Definitions
// ==========================================

const GIT_DEF: CommandDef = {
    name: 'git',
    desc: 'Distributed version control system (KinbroOS)',
    options: [
        { long: 'version', desc: 'Show version' },
        { long: 'exec-path', desc: 'Show exec path (dummy)' }
    ],
    subCommands: {
        'help': { 
            name: 'git help', desc: 'Display help', usage: '<command>' 
        },
        'init': { 
            name: 'git init', desc: 'Init repo', usage: '[dir]' 
        },
        'status': { 
            name: 'git status', desc: 'Show status' 
        },
        'ls-files': {
            name: 'git ls-files', desc: 'Show information about files in the index and the working tree',
            options: [
                { short: 'c', long: 'cached', desc: 'Show cached files in the output (default)' }, 
                { short: 'd', long: 'deleted', desc: 'Show deleted files in the output' },
                { short: 'm', long: 'modified', desc: 'Show modified files in the output' }, 
                { short: 'o', long: 'others', desc: 'Show other (i.e. untracked) files in the output' },
                { short: 's', long: 'stage', desc: 'Show staged contents\' mode bits, object name and stage number' }
            ]
        },
        'add': { 
            name: 'git add', desc: 'Add file contents to the index', usage: '<pathspec>...' 
        },
        'rm': { 
            name: 'git rm', desc: 'Remove files from the working tree and from the index', usage: '<pathspec>...' 
        },
        'commit': {
            name: 'git commit', desc: 'Record changes to the repository',
            options: [
                { short: 'm', long: 'message', hasArg: true, desc: 'Commit message' },
                { short: 'a', long: 'all', desc: 'Stage all modified and deleted files' }
            ]
        },
        'log': {
            name: 'git log', desc: 'Show commit logs',
            options: [
                { short: 'n', hasArg: true, desc: 'Limit number of commits' },
                { short: 'p', long: 'patch', desc: 'Show changes for each commit' },
                { long: 'stat', desc: 'Show stats (dummy)' }
            ]
        },
        'show': {
            name: 'git show', desc: 'Show various types of objects',
            usage: '[<object>]',
            options: [
                { long: 'color', desc: 'Turn on colored output' }, 
                { long: 'no-color', desc: 'Turn off colored output' }
            ]
        },
        'diff': {
            name: 'git diff', desc: 'Show changes between commits, commit and working tree, etc',
            usage: '[options] [<commit>] [--] [<path>...]',
            options: [
                { long: 'cached', desc: 'View changes staged for the next commit' }, 
                { long: 'staged', desc: 'Synonym for --cached' }, 
                { long: 'name-only', desc: 'Show only names of changed files' },
                { long: 'color', desc: 'Show colored diff' }, 
                { long: 'no-color', desc: 'Turn off colored diff' }
            ]
        },
        'branch': { 
            name: 'git branch', desc: 'List, create, or delete branches', 
            options: [
                { short: 'd', desc: 'Delete a branch' }, 
                { short: 'D', desc: 'Force delete a branch' }, 
                { short: 'a', desc: 'List all branches' }
            ] 
        },
        'checkout': { 
            name: 'git checkout', desc: 'Switch branches or restore working tree files', 
            options: [
                { short: 'b', desc: 'Create and switch to a new branch' }
            ] 
        },
        'merge': { 
            name: 'git merge', desc: 'Join two or more development histories together', usage: '<branch>' 
        },
        'tag': { 
            name: 'git tag', desc: 'Create, list, delete or verify a tag object', 
            options: [
                { short: 'd', desc: 'Delete a tag' }
            ] 
        },
        'reset': { 
            name: 'git reset', desc: 'Reset current HEAD to the specified state', 
            options: [
                { long: 'hard', desc: 'Resets the index and working tree' }, 
                { long: 'soft', desc: 'Does not touch the index file or the working tree' }, 
                { long: 'mixed', desc: 'Resets the index but not the working tree' }
            ] 
        },
        'config': { 
            name: 'git config', desc: 'Get and set repository or global options', 
            options: [
                { long: 'list', desc: 'List all' }, 
                { long: 'global', desc: 'Use global config file' }
            ] 
        }
    }
};

// ==========================================
// Helper Functions (Path & Repo Discovery)
// ==========================================

async function findRepoRoot(proc: IProcess, startDir: string): Promise<string | null> {
    let current = startDir;
    while (true) {
        if (await proc.fs.exists(`${current}/.git`)) {
            return current;
        }
        if (current === '/' || current === '') {
            return null;
        }
        const parts = current.split('/');
        parts.pop();
        current = parts.join('/') || '/';
    }
}

function resolveRepoPath(ctx: GitContext, userPath: string): string {
    if (userPath === '.') return ctx.prefix ? ctx.prefix : '.'; 
    
    let fullPath = ctx.prefix ? `${ctx.prefix}/${userPath}` : userPath;
    if (fullPath.startsWith('./')) fullPath = fullPath.substring(2);
    
    return fullPath;
}

function getAuthor(proc: IProcess) {
    return {
        name: proc.env.get('GIT_AUTHOR_NAME') || proc.env.get('USER') || 'Kinbro User',
        email: proc.env.get('GIT_EMAIL') || 'user@kinbro.os'
    };
}

// ==========================================
// The Diff Engine
// ==========================================

async function execFileDiff(
    ctx: GitContext, 
    path: string, 
    bufA: Uint8Array, 
    bufB: Uint8Array, 
    opts: DiffOptions
) {
    const { proc, sys, writer, errWriter } = ctx;

    const isBinary = (buf: Uint8Array) => {
        const sub = buf.subarray(0, Math.min(buf.length, 8000));
        return sub.includes(0);
    };

    if (isBinary(bufA) || isBinary(bufB)) {
        await writer.writeString(`Binary files a/${path} and b/${path} differ\n`);
        return;
    }

    const tmpNameA = `/tmp/git_a_${Math.floor(Math.random()*100000)}`;
    const tmpNameB = `/tmp/git_b_${Math.floor(Math.random()*100000)}`;

    await proc.fs.writeFile(tmpNameA, bufA);
    await proc.fs.writeFile(tmpNameB, bufB);

    try {
        const bridgeStdout = new WritableStream<Uint8Array>({
            write(chunk) { return writer.write(chunk); }
        });
        const bridgeStderr = new WritableStream<Uint8Array>({
            write(chunk) { return errWriter.write(chunk); }
        });

        const diffArgs = ['-u'];
        if (opts.useColor) diffArgs.push('--color');
        diffArgs.push('--label', `a/${path}`);
        diffArgs.push('--label', `b/${path}`);
        diffArgs.push(tmpNameA);
        diffArgs.push(tmpNameB);

        await sys.execPath(
            proc, 
            'diff', 
            diffArgs, 
            true, 
            {
                stdin: undefined,
                stdout: proc.createStdoutStream(bridgeStdout, StreamData.Uint8Array),
                stderr: proc.createStdoutStream(bridgeStderr, StreamData.Uint8Array)
            }
        );
    } catch (e) {
        // diff command returns exit code 1 if diffs found, which is normal.
    } finally {
        try { await proc.fs.unlink(tmpNameA); } catch {}
        try { await proc.fs.unlink(tmpNameB); } catch {}
    }
}

async function runDiffWalker(
    ctx: GitContext, 
    DriverA: any, 
    DriverB: any, 
    filterPaths: string[],
    opts: DiffOptions
) {
    const { fs, repoRoot, writer } = ctx;
    const diffTasks: { filepath: string, A: any, B: any, oidA?: string, oidB?: string }[] = [];

    // 1. Walk Phase
    await git.walk({
        fs, dir: repoRoot,
        trees: [DriverA, DriverB],
        map: async (filepath, [A, B]) => {
            if (filepath === '.') return;

            // Ignore nested .git directories
            const segments = filepath.split('/');
            if (segments.includes('.git')) return;

            // Path filter
            if (filterPaths.length > 0) {
                const match = filterPaths.some(p => filepath === p || filepath.startsWith(p + '/'));
                if (!match) return;
            }
            if (!A && !B) return;

            const typeA = A ? await A.type() : undefined;
            const typeB = B ? await B.type() : undefined;
            if (typeA === 'tree' || typeB === 'tree') return;

            const oidA = A ? await A.oid() : undefined;
            const oidB = B ? await B.oid() : undefined;
            if (oidA && oidB && oidA === oidB) return;

            if (!opts.cached && !A && !oidA) {
                // Ignore untracked files in standard diff
            }

            diffTasks.push({ filepath, A, B, oidA, oidB });
        }
    });

    // 2. Execution Phase
    for (const task of diffTasks) {
        const { filepath, A, B, oidA, oidB } = task;

        if (opts.nameOnly) {
            await writer.writeString(`${filepath}\n`);
            continue;
        }

        // Fallback Strategy for Content Extraction
        const getBuffer = async (entry: any, oid?: string) => {
            if (!entry) return new Uint8Array(0);
            try {
                const res = await entry.content();
                if (res) return res;
            } catch {}
            if (oid) {
                try {
                    const { blob } = await git.readBlob({ fs, dir: repoRoot, oid });
                    return blob;
                } catch {}
            }
            return new Uint8Array(0);
        };

        const bufA = await getBuffer(A, oidA);
        const bufB = await getBuffer(B, oidB);

        await execFileDiff(ctx, filepath, bufA, bufB, opts);
    }
}

// ==========================================
// Main Entry Point
// ==========================================

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, GIT_DEF);
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());
    const fs = (proc.fs as any).getBackend();

    try {
        if (parser.has(undefined, 'version')) {
            await writer.writeString(`git version 1.2.0 (KinbroOS)\n`);
            return 0;
        }

        const subCmd = parser.subCommandName;
        const subP = parser.subParser;
        
        if (!subCmd || parser.isHelpRequested) {
            await writer.writeString(parser.getHelp());
            return 0;
        }

        const cwd = proc.fs.getCWD();
        
        // Repository Detection
        let repoRoot = cwd;
        let prefix = '';

        if (subCmd !== 'init' && subCmd !== 'help') {
            const foundRoot = await findRepoRoot(proc, cwd);
            if (!foundRoot) {
                await errWriter.writeString(`fatal: not a git repository (or any of the parent directories): .git\n`);
                return 128;
            }
            repoRoot = foundRoot;
            if (cwd !== repoRoot) {
                prefix = cwd.slice(repoRoot.length + (repoRoot === '/' ? 0 : 1));
            }
        }

        const ctx: GitContext = { fs, proc, sys, writer, errWriter, repoRoot, cwd, prefix };

        switch (subCmd) {
            case 'help': await cmdHelp(ctx, subP!); break;
            case 'init': await cmdInit(ctx, subP!); break;
            case 'status': await cmdStatus(ctx, subP!); break;
            case 'ls-files': await cmdLsFiles(ctx, subP!); break;
            case 'add': await cmdAdd(ctx, subP!); break;
            case 'rm': await cmdRm(ctx, subP!); break;
            case 'commit': await cmdCommit(ctx, subP!); break;
            case 'log': await cmdLog(ctx, subP!); break;
            case 'show': await cmdShow(ctx, subP!); break;
            case 'diff': await cmdDiff(ctx, subP!); break;
            case 'branch': await cmdBranch(ctx, subP!); break;
            case 'checkout': await cmdCheckout(ctx, subP!); break;
            case 'merge': await cmdMerge(ctx, subP!); break;
            case 'tag': await cmdTag(ctx, subP!); break;
            case 'reset': await cmdReset(ctx, subP!); break;
            case 'config': await cmdConfig(ctx, subP!); break;
            default: await errWriter.writeString(`git: '${subCmd}' not implemented.\n`); return 1;
        }

    } catch (e: any) {
        await errWriter.writeString(`git: error: ${e.message}\n`);
        return 1;
    } finally {
        await writer.close();
        await errWriter.close();
    }
    return 0;
}

// ==========================================
// Subcommands
// ==========================================

async function cmdHelp({writer}:GitContext, p:CommandParser){ 
    await writer.writeString("See 'git --help' for usage.\n"); 
}

async function cmdInit({fs, cwd, writer}: GitContext, p: CommandParser) {
    const target = p.args[0] ? (p.args[0].startsWith('/') ? p.args[0] : `${cwd}/${p.args[0]}`) : cwd;
    await git.init({ fs, dir: target });
    await writer.writeString(`Initialized empty Git repository in ${target}/.git/\n`);
}

async function cmdStatus({fs, repoRoot, writer}: GitContext, p: CommandParser) {
    const matrix = await git.statusMatrix({ fs, dir: repoRoot });
    const changed = matrix.filter(r => r[1]!==r[2]||r[2]!==r[3]);
    
    if(changed.length===0) await writer.writeString("On branch master\nNothing to commit, working tree clean\n");
    else {
        for(const r of changed) await writer.writeString(`${r[0]}\n`);
    }
}

async function cmdLsFiles({fs, repoRoot, writer}: GitContext, p: CommandParser) {
    const isStage = p.has('s', 'stage');
    // Note: Filtering args logic is simplified here.
    if (isStage) {
        await git.walk({
            fs, dir: repoRoot, trees: [git.STAGE()],
            map: async (filepath, [stage]) => {
                if (!stage || filepath === '.') return;
                const segments = filepath.split('/');
                if (segments.includes('.git')) return;
                const oid = await stage.oid();
                const mode = await stage.mode();
                await writer.writeString(`${mode.toString(8)} ${oid} 0\t${filepath}\n`);
            }
        });
    } else {
        const m = await git.statusMatrix({ fs, dir: repoRoot });
        for(const r of m) if(r[0]!=='.') await writer.writeString(`${r[0]}\n`);
    }
}

async function cmdAdd({fs, repoRoot, prefix}: GitContext, p: CommandParser) {
    const args = p.args;
    if (args.length === 0) throw new Error("Nothing specified, nothing added.");

    for(const arg of args) {
        if (arg === '.') {
            if (prefix) await git.add({ fs, dir: repoRoot, filepath: prefix }); 
            else await git.add({ fs, dir: repoRoot, filepath: '.' });
        } else {
            const fullPath = resolveRepoPath({ repoRoot, prefix } as any, arg);
            await git.add({ fs, dir: repoRoot, filepath: fullPath });
        }
    }
}

async function cmdRm({fs, repoRoot, prefix}: GitContext, p: CommandParser) {
    for(const f of p.args) {
        const fullPath = resolveRepoPath({ repoRoot, prefix } as any, f);
        await git.remove({ fs, dir: repoRoot, filepath: fullPath });
    }
}

async function cmdCommit({fs, repoRoot, proc, writer}: GitContext, p: CommandParser) {
    const msg = p.get('message') as string;
    if(!msg) throw new Error("-m required");
    const oid = await git.commit({ fs, dir: repoRoot, message: msg, author: getAuthor(proc) });
    await writer.writeString(`[${oid.slice(0,7)}] ${msg}\n`);
}

async function cmdLog(ctx: GitContext, p: CommandParser) {
    const { fs, repoRoot, writer } = ctx;
    const depthVal = p.get('n');
    const depth = depthVal ? parseInt(depthVal as string) : 20;
    const showPatch = p.has('p', 'patch');
    const useColor = !p.has(undefined, 'no-color'); 

    const commits = await git.log({ fs, dir: repoRoot, depth });
    
    for (const c of commits) {
        const sha = c.oid;
        const msg = c.commit.message;
        const author = c.commit.author;
        const dateStr = new Date(author.timestamp * 1000).toString();
        const cYellow = useColor ? '\x1b[33m' : '';
        const cReset = useColor ? '\x1b[0m' : '';

        await writer.writeString(`${cYellow}commit ${sha}${cReset}\n`);
        await writer.writeString(`Author: ${author.name} <${author.email}>\n`);
        await writer.writeString(`Date:   ${dateStr}\n\n`);
        await writer.writeString(`    ${msg.trim().split('\n').join('\n    ')}\n\n`);

        if (showPatch) {
            let parentOid = c.commit.parent[0];
            let DriverA = parentOid ? git.TREE({ ref: parentOid }) : git.TREE({ ref: EMPTY_TREE_OID });
            let DriverB = git.TREE({ ref: sha });
            
            await runDiffWalker(ctx, DriverA, DriverB, [], { useColor, cached: true });
        }
    }
}

async function cmdShow(ctx: GitContext, parser: CommandParser) {
    const { fs, repoRoot, writer } = ctx;
    const object = parser.args[0] || 'HEAD';
    const useColor = !parser.has(undefined, 'no-color');

    const oid = await git.resolveRef({ fs, dir: repoRoot, ref: object });
    const { type, object: obj } = await (git as any).read({ fs, dir: repoRoot, oid });

    if (type !== 'commit') {
        await writer.writeString(`git show: ${type} objects not supported yet.\n`);
        return;
    }

    const commit = obj as any; 
    const author = commit.author;
    const cYellow = useColor ? '\x1b[33m' : '';
    const cReset = useColor ? '\x1b[0m' : '';
    
    await writer.writeString(`${cYellow}commit ${oid}${cReset}\n`);
    await writer.writeString(`Author: ${author.name} <${author.email}>\n`);
    await writer.writeString(`Date:   ${new Date(author.timestamp * 1000).toString()}\n\n`);
    await writer.writeString(`    ${commit.message.trim().split('\n').join('\n    ')}\n\n`);

    let parentOid = commit.parent[0];
    let DriverA = parentOid ? git.TREE({ ref: parentOid }) : git.TREE({ ref: EMPTY_TREE_OID });
    let DriverB = git.TREE({ ref: oid });

    await runDiffWalker(ctx, DriverA, DriverB, [], { useColor, cached: true });
}

async function cmdDiff(ctx: GitContext, parser: CommandParser) {
    const { fs, repoRoot, prefix } = ctx;
    
    const isCached = parser.has(undefined, 'cached') || parser.has(undefined, 'staged');
    const isNameOnly = parser.has(undefined, 'name-only');
    const useColor = !parser.has(undefined, 'no-color');
    
    const args = [...parser.args];
    const resolve = async (r: string) => { try { return await git.resolveRef({ fs, dir: repoRoot, ref: r }); } catch { return undefined; } };
    
    let ref1: string | undefined;
    let ref2: string | undefined;
    
    if (args.length > 0 && await resolve(args[0])) {
        ref1 = args.shift();
        if (args.length > 0 && await resolve(args[0])) ref2 = args.shift();
    }
    
    const paths = args.map(p => resolveRepoPath(ctx, p));

    let DriverA: any;
    let DriverB: any;
    let allowUntracked = false;

    if (ref1 && ref2) {
        DriverA = git.TREE({ ref: ref1 });
        DriverB = git.TREE({ ref: ref2 });
        allowUntracked = true;
    } else if (ref1) {
        if (isCached) {
            DriverA = git.TREE({ ref: ref1 });
            DriverB = git.STAGE();
        } else {
            DriverA = git.TREE({ ref: ref1 });
            DriverB = git.WORKDIR();
        }
        allowUntracked = true;
    } else {
        if (isCached) {
            DriverA = git.TREE({ ref: 'HEAD' });
            DriverB = git.STAGE();
            allowUntracked = true;
        } else {
            DriverA = git.STAGE();
            DriverB = git.WORKDIR();
            allowUntracked = false; 
        }
    }

    await runDiffWalker(ctx, DriverA, DriverB, paths, { 
        useColor, 
        nameOnly: isNameOnly,
        cached: allowUntracked || isCached 
    });
}

async function cmdBranch({fs, repoRoot, writer}: GitContext, p: CommandParser){
    const bs = await git.listBranches({fs, dir: repoRoot});
    for(const b of bs) await writer.writeString(`${b}\n`);
}
async function cmdCheckout({fs, repoRoot, writer}: GitContext, p: CommandParser){
    await git.checkout({fs, dir: repoRoot, ref:p.args[0]});
    await writer.writeString(`Checked out ${p.args[0]}\n`);
}
async function cmdMerge({fs, repoRoot, proc, writer}: GitContext, p: CommandParser){
    await git.merge({fs, dir: repoRoot, ours:'master', theirs:p.args[0], author:getAuthor(proc)});
    await writer.writeString("Merged.\n");
}
async function cmdTag({fs, repoRoot, writer}: GitContext, p: CommandParser){
    const ts = await git.listTags({fs, dir: repoRoot});
    for(const t of ts) await writer.writeString(`${t}\n`);
}
async function cmdReset({fs, repoRoot, writer}: GitContext, p: CommandParser){
    const hard = p.has(undefined, 'hard');
    const commit = p.args[0];

    if (hard && commit) {
        await git.checkout({ fs, dir: repoRoot, ref: commit, force: true });
        const currentBranch = await git.currentBranch({ fs, dir: repoRoot });
        if (currentBranch) {
             const oid = await git.resolveRef({ fs, dir: repoRoot, ref: commit });
             await git.writeRef({ fs, dir: repoRoot, ref: `refs/heads/${currentBranch}`, value: oid, force: true });
             await git.checkout({ fs, dir: repoRoot, ref: currentBranch, force: true });
             await writer.writeString(`HEAD is now at ${oid.slice(0,7)}\n`);
        } else {
             await writer.writeString(`Cannot reset: not on a branch\n`);
        }
    } else {
        await writer.writeString(`git reset: only --hard <commit> is supported in this version.\n`);
    }
}
async function cmdConfig({fs, repoRoot, writer}: GitContext, p: CommandParser){
    if (p.has(undefined, 'list')) {
        const name = await git.getConfig({ fs, dir: repoRoot, path: 'user.name' });
        const email = await git.getConfig({ fs, dir: repoRoot, path: 'user.email' });
        await writer.writeString(`user.name=${name}\nuser.email=${email}\n`);
        return;
    }
    if (p.args.length >= 2) {
        const key = p.args[0];
        const val = p.args[1];
        await git.setConfig({ fs, dir: repoRoot, path: key, value: val });
    } else if (p.args.length === 1) {
        const val = await git.getConfig({ fs, dir: repoRoot, path: p.args[0] });
        await writer.writeString(`${val}\n`);
    }
}
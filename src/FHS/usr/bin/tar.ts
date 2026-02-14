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
import { Archiver } from '../../boot/Archiver';
import { createFileSinkStream, createFileSourceStream } from '../lib/FileStreamAdapter';

/**
 * [Command: tar]
 * アーカイブユーティリティ。
 * Kernel Moduleである Archiver クラスのラッパーとして機能し、
 * ストリームベースの .tar.gz 作成・展開を提供する。
 */
export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    const parser = new CommandParser(args, {
        name: 'tar',
        usage: '[OPTION...] [FILE]...',
        desc: 'GNU tar saves many files together into a single tape or disk archive, and can restore individual files from the archive.',
        options: [
            { short: 'c', long: 'create', desc: 'create a new archive' },
            { short: 'x', long: 'extract', desc: 'extract files from an archive' },
            { short: 't', long: 'list', desc: 'list the contents of an archive' }, // Current Archiver doesn't support list stream yet, but reserving flag
            { short: 'f', long: 'file', desc: 'use archive file or device ARCHIVE', hasArg: true },
            { short: 'v', long: 'verbose', desc: 'verbosely list files processed' },
            { short: 'z', long: 'gzip', desc: 'filter the archive through gzip' },
            { short: 'C', long: 'directory', desc: 'change to directory DIR', hasArg: true },
            { long: 'help', desc: 'display this help and exit' },
            { long: 'version', desc: 'output version information and exit' }
        ]
    });

    if (parser.has(undefined, 'help')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString(parser.getHelp());
        await writer.close();
        return 0;
    }

    if (parser.has(undefined, 'version')) {
        const writer = new BinaryWriter(proc.stdout!.getByteWriter());
        await writer.writeString('tar (KinbroOS) 1.0\nBased on GNU tar 1.34 logic\n');
        await writer.close();
        return 0;
    }

    // --- Mode Selection ---
    const isCreate = parser.has('c', 'create');
    const isExtract = parser.has('x', 'extract');
    
    if (!isCreate && !isExtract) {
        const writer = new BinaryWriter(proc.stderr!.getByteWriter());
        await writer.writeString('tar: You must specify one of the options -c, -x\nTry \'tar --help\' for more information.\n');
        await writer.close();
        return 1;
    }

    // --- Setup Context ---
    const archiver = new Archiver(proc.fs);
    const strArchiveFile = parser.get('file') as string;
    const targets = parser.args; // 残りの引数 (対象ファイル/ディレクトリ)
    
    // 作業ディレクトリの変更 (-C)
    // ※ プロセスのCWDを変えるわけにはいかないので、Archiverへのパス解決時に考慮する必要があるが、
    //    現在のArchiverは絶対パス/相対パスをそのまま受け取る。
    //    簡易実装として process.chdir 相当を行うか、パス結合で対応する。
    //    今回は簡易的に、argsのパス解釈に委ねる（-Cの実装はFS依存が深いため今回はスキップし、Noteに残す）

    try {
        if (isCreate) {
            // ==========================================
            // 🎁 Create Mode (-c)
            // ==========================================
            if (targets.length === 0) {
                throw new Error('tar: Cowardly refusing to create an empty archive');
            }

            // Current Archiver Limitation: Single root support mainly.
            // 複数指定された場合は、とりあえず最初の1つを処理するか、ループする設計。
            // Archiver.archive returns a Stream.
            // 複数ファイルを1つのtarにするには streamTar のループが必要だが、
            // 公開APIの archive() は単一パスしか受け取らない。
            // → 今回は「最初の引数のみ」をアーカイブする仕様とする (or Wrap logic needed)
            const srcPath = targets[0]; 

            // Output Destination
            let wsOutput: WritableStream<Uint8Array>;

            if (!strArchiveFile || strArchiveFile === '-') {
                // Stdout
                if (!proc.stdout) throw new Error('tar: Standard output not available');
                wsOutput = proc.stdout.getByteWriter() as any; 
                // Note: stdoutは閉じない方が行儀が良いが、tarのメイン出力なので閉じる責務を持つ場合もある。
                // proc.stdout自体はcloseしないが、writerはreleaseする。
            } else {
                // File
                const handle = await proc.fs.open(strArchiveFile, 'w');
                wsOutput = createFileSinkStream(handle);
            }

            // Execute
            // Archiver.archive は .tar.gz の ReadableStream を返す
            const rsArchive = archiver.archive(srcPath);

            // Pipe: rsArchive -> wsOutput
            await rsArchive.pipeTo(wsOutput);

        } else if (isExtract) {
            // ==========================================
            // 📦 Extract Mode (-x)
            // ==========================================
            
            // Input Source
            let rsInput: ReadableStream<Uint8Array>;

            if (!strArchiveFile || strArchiveFile === '-') {
                // Stdin
                if (!proc.stdin) throw new Error('tar: Standard input not available');
                rsInput = proc.stdin.getByteReader() as any;
            } else {
                // File
                const handle = await proc.fs.open(strArchiveFile, 'r');
                rsInput = createFileSourceStream(handle);
            }

            // Destination Dir (Default: Current Directory)
            // -C オプションがあればそこへ、なければ '.'
            const destDir = (parser.get('directory') as string) || '.';
            
            // Execute
            // extract() は内部で DecompressionStream('gzip') を通す
            // 入力が生tarの場合はエラーになる可能性があるが、現在は .tar.gz 前提
            await archiver.extract(rsInput, destDir);
        }

    } catch (e: any) {
        const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());
        await errWriter.writeString(`tar: ${e.message}\n`);
        await errWriter.close();
        return 1;
    }

    return 0;
}
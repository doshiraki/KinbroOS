// src/FHS/usr/bin/kibshcli.ts

import { SystemAPI } from '../../../dev/types/SystemAPI';
import { IProcess } from '../../../dev/types/IProcess';
import { Kibsh } from './kibsh';
import { BinaryReader, BinaryWriter, IBinaryWriter } from '../lib/StreamUtils';

function createShieldedWriter(target: IBinaryWriter): IBinaryWriter {
    return {
        get raw() { return target.raw; },
        write: (chunk) => target.write(chunk),
        writeString: (str) => target.writeString(str),
        releaseLock: () => target.releaseLock(),
        close: () => Promise.resolve() // 🌟 Close 無効化
    };
}

export async function main(args: string[], sys: SystemAPI, proc: IProcess): Promise<number> {
    if (args.length === 0) return 0;

    const shell = new Kibsh(sys, proc);
    const reader = new BinaryReader(proc.stdin!.getByteReader());
    const writer = new BinaryWriter(proc.stdout!.getByteWriter());
    
    // 🌟 ここでシールドを作る
    const shieldedWriter = createShieldedWriter(writer);

    let lastExitCode = 0;

    try {
        for (const cmd of args) {
            if (!cmd.trim()) continue;
            await writer.writeString(`$ ${cmd}\n`);
            
            // 🌟 シールド付きを渡す
            lastExitCode = await shell.executeLogic(cmd, reader, shieldedWriter);
        }
    } catch (e: any) {
        const errWriter = new BinaryWriter(proc.stderr!.getByteWriter());
        await errWriter.writeString(`kibshcli: fatal error: ${e.message}\n`);
        await errWriter.close();
        return 1;
    } finally {
        reader.releaseLock();
        await writer.close(); // 最後は本物を閉じる
    }

    return lastExitCode;
}
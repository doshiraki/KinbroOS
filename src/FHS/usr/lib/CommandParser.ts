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

/**
 * [Definition-Driven Parser 2.1]
 * - SubCommand対応
 * - Recursive Help Detection (再帰的ヘルプ検知)
 */

export interface OptionDef {
    short?: string;
    long?: string;
    desc: string;
    hasArg?: boolean; 
}

export interface CommandDef {
    name: string;       
    usage?: string;     
    desc: string;
    options?: OptionDef[];
    subCommands?: Record<string, CommandDef>;
}

export class CommandParser {
    private setFlags: Set<string> = new Set();
    private mapOptionValues: Map<string, string[]> = new Map();
    private arrPositionals: string[] = [];
    private objDef: CommandDef;

    public subParser?: CommandParser;
    public subCommandName?: string;

    constructor(arrArgs: string[], objDef: CommandDef) {
        this.objDef = { ...objDef };
        this.objDef.options = this.objDef.options || [];

        // 全コマンド共通 --help, -h
        if (!this.objDef.options.find(d => d.long === 'help')) {
            this.objDef.options.push({ short: 'h', long: 'help', desc: 'display this help and exit' });
        }

        this.parse(arrArgs);
    }

    private parse(arrArgs: string[]): void {
        let i = 0;
        while (i < arrArgs.length) {
            const strArg = arrArgs[i];

            if (strArg === '--') {
                for (let j = i + 1; j < arrArgs.length; j++) this.arrPositionals.push(arrArgs[j]);
                break;
            } 
            
            if (strArg.startsWith('-') && strArg !== '-') {
                i = this.parseFlag(strArg, arrArgs, i);
                i++;
                continue;
            }

            // サブコマンド判定
            if (this.objDef.subCommands && this.objDef.subCommands[strArg]) {
                this.subCommandName = strArg;
                const subDef = this.objDef.subCommands[strArg];
                const remainingArgs = arrArgs.slice(i + 1);
                this.subParser = new CommandParser(remainingArgs, subDef);
                return; // 委譲して終了
            }

            this.arrPositionals.push(strArg);
            i++;
        }
    }

    private parseFlag(strArg: string, arrArgs: string[], i: number): number {
        if (strArg.startsWith('--')) {
            const raw = strArg.slice(2);
            const eqIdx = raw.indexOf('=');
            let name = raw;
            let val: string | undefined;

            if (eqIdx !== -1) {
                name = raw.slice(0, eqIdx);
                val = raw.slice(eqIdx + 1);
            }

            const def = this.findDef(name);
            if (def && def.hasArg) {
                if (val === undefined) {
                    if (i + 1 < arrArgs.length) val = arrArgs[++i];
                    else val = ""; 
                }
                this.addValue(name, val);
            } else {
                this.setFlags.add(name);
            }
        } else {
            const chars = strArg.slice(1);
            for (let j = 0; j < chars.length; j++) {
                const char = chars[j];
                const def = this.findDef(char);
                
                if (def && def.hasArg) {
                    let val = chars.slice(j + 1);
                    if (val.length === 0) {
                        if (i + 1 < arrArgs.length) val = arrArgs[++i];
                    }
                    this.addValue(char, val);
                    break; 
                } else {
                    this.setFlags.add(char);
                }
            }
        }
        return i;
    }

    private findDef(name: string): OptionDef | undefined {
        return this.objDef.options?.find(d => d.short === name || d.long === name);
    }

    private addValue(key: string, val: string) {
        if (!this.mapOptionValues.has(key)) {
            this.mapOptionValues.set(key, []);
        }
        this.mapOptionValues.get(key)!.push(val);
    }

    public validate(): string | null {
        if (this.subParser) return this.subParser.validate();

        const setAllowed = new Set<string>();
        for (const def of this.objDef.options!) {
            if (def.short) setAllowed.add(def.short);
            if (def.long) setAllowed.add(def.long);
        }

        for (const strFlag of this.setFlags) {
            if (!setAllowed.has(strFlag)) return `${this.objDef.name}: invalid option -- '${strFlag}'`;
        }
        for (const strKey of this.mapOptionValues.keys()) {
            if (!setAllowed.has(strKey)) return `${this.objDef.name}: invalid option -- '${strKey}'`;
        }
        return null;
    }

    public getHelp(): string {
        // ✨ 子がヘルプを要求しているなら、子のヘルプを返す (git commit --help)
        if (this.subParser && this.subParser.isHelpRequested) {
            return this.subParser.getHelp();
        }

        let strOut = `Usage: ${this.objDef.name} ${this.objDef.usage || '[options]'}\n`;
        if (this.objDef.desc) strOut += `\n${this.objDef.desc}\n`;
        
        if (this.objDef.subCommands) {
            strOut += `\nAvailable Commands:\n`;
            const maxLen = Math.max(0, ...Object.keys(this.objDef.subCommands).map(k => k.length));
            for (const [cmdName, cmdDef] of Object.entries(this.objDef.subCommands)) {
                strOut += `  ${cmdName.padEnd(maxLen + 4, ' ')}${cmdDef.desc}\n`;
            }
        }

        if (this.objDef.options!.length > 0) {
            strOut += `\nOptions:\n`;
            for (const def of this.objDef.options!) {
                const parts = [];
                if (def.short) parts.push(`-${def.short}`);
                if (def.long) parts.push(`--${def.long}`);
                
                let argHint = def.hasArg ? " ARG" : "";
                const strFlags = parts.join(', ') + argHint;
                strOut += `  ${strFlags.padEnd(24, ' ')}${def.desc}\n`;
            }
        }
        return strOut;
    }

    public has(short?: string, long?: string): boolean {
        const check = (key: string) => this.setFlags.has(key) || this.mapOptionValues.has(key);
        return (!!short && check(short)) || (!!long && check(long));
    }

    public get(key: string): string | string[] | undefined {
        const def = this.findDef(key);
        const values: string[] = [];
        if (def) {
            if (def.short && this.mapOptionValues.has(def.short)) values.push(...this.mapOptionValues.get(def.short)!);
            if (def.long && this.mapOptionValues.has(def.long)) values.push(...this.mapOptionValues.get(def.long)!);
        } else {
            if (this.mapOptionValues.has(key)) values.push(...this.mapOptionValues.get(key)!);
        }
        if (values.length === 0) return undefined;
        if (values.length === 1) return values[0];
        return values;
    }

    public get args(): string[] { return this.arrPositionals; }
    public get isSubCommandSelected(): boolean { return !!this.subParser; }
    
    // ✨ 修正: 自身がヘルプ要求を持っているか、または子がヘルプ要求を持っているか
    public get isHelpRequested(): boolean { 
        return this.has('h', 'help') || (this.subParser?.isHelpRequested ?? false); 
    }
}
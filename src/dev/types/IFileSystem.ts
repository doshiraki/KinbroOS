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
 * [Interface: IFileSystem]
 * ユーザーランドから利用可能なファイルシステム操作の定義。
 * カーネルの FileSystemManager がこれを実装(Implements)する形になる。
 */
import type { Stats } from '@zenfs/core'; // もし型が見つからなければ 'fs' から取ってもOK
import { IFileStream } from './IFileStream';
export interface IFileSystem {
    /**
     * [SysCall: Rmdir] (New)
     * ディレクトリを削除する
     */
    rmdir(pathTarget: string): Promise<void>;
    
    /**
     * [SysCall: Lstat] (New)
     * ファイル/ディレクトリの情報を取得する (リンクならリンク自体の情報を返す)
     */
    lstat(path: string): Promise<Stats>;

    /**
     * [SysCall: Rename] (New)
     * ファイル名を変更、または移動する
     */
    rename(oldPath: string, newPath: string): Promise<void>;

    chmod(pathFile: string, mode: number): Promise<void>;

    getBackend(): any;

    mount(handleRoot: FileSystemDirectoryHandle, handleBoot?: FileSystemDirectoryHandle): Promise<void>;

    resolvePath(pathInput: string, baseDir?: string): string;
    
    /**
     * ファイルの内容を読み込む
     * @param path 対象パス
     * @param type 読み込み形式 ('utf8' | 'binary')
     */
    readFile(path: string, type?: 'utf8' | 'binary'): Promise<string | Uint8Array>;

    /**
     * ファイルにデータを書き込む (上書き)
     * @param path 対象パス
     * @param data 書き込むデータ
     */
    writeFile(path: string, data: string | Uint8Array): Promise<void>;

    /**
     * ファイルまたはディレクトリが存在するか確認する
     */
    exists(path: string): Promise<boolean>;

    /**
     * ディレクトリ内のエントリ一覧を取得する
     */
    readDir(path: string): Promise<string[]>;

    /**
     * [SysCall: Unlink]
     * 指定されたパスのファイルを削除する (git diff の後片付けなどで使用)
     */
    unlink(pathTarget: string): Promise<void>;

    /**
     * ディレクトリを作成する
     * @param path 作成するパス
     * @param isRecursive 親ディレクトリも作成するか ('-p' option)
     */
    makeDir(path: string, isRecursive?: boolean): Promise<void>;

    /**
     * 空ファイルを作成、またはタイムスタンプを更新する
     */
    touchFile(path: string): Promise<void>;

    /**
     * ファイル/ディレクトリの情報を取得する
     * (詳細なStats型は依存を避けるため any としているが、必要ならIStatsを定義する)
     */
    getStat(path: string): Promise<Stats>;

    /**
     * 現在の作業ディレクトリ(CWD)を取得する
     */
    getCWD(): string;

    /**
     * 作業ディレクトリを変更する
     */
    changeDir(path: string): Promise<void>;

    /**
     * 指定ディレクトリ以下を再帰的に探索し、全ファイルパスのリストを返す
     */
    findRecursive(path: string): Promise<string[]>;

    /**
         * [SysCall: Open]
         * 指定されたパスを開き、高機能なストリームラッパーを返す。
         * @param pathTarget 対象ファイルパス
         * @param flags フラグ ('r', 'w', 'a', 'r+' など)
         * @param bufferSize (Optional) 内部バッファサイズ。省略時はFileStreamのデフォルト(64KB)が使用される。
         */
    open(pathTarget: string, flags: string, bufferSize?: number): Promise<IFileStream>;    
}
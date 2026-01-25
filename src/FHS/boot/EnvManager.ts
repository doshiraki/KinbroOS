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

import { IEnvManager, EnvKey, EnvKeyType } from '../../dev/types/IEnvManager';

/**
 * [Class: EnvManager]
 * 環境変数を管理するクラス。
 * システムグローバルなインスタンスは永続化(localStorage)され、
 * 子プロセス用のインスタンスはインメモリで動作する。
 */
export class EnvManager implements IEnvManager {
    private readonly strNamespace = 'ms_env_';
    private readonly mapCache: Map<string, string> = new Map(); // Key型をstringに緩和
    
    // 永続化するかどうかのフラグ (子プロセス用はfalseにする)
    private readonly isPersistent: boolean;

    /**
     * @param initialData 初期データ (clone用)
     * @param isPersistent localStorageに保存するか (Default: true)
     */
    constructor(initialData?: Record<string, string>, isPersistent: boolean = false) {
        this.isPersistent = window["localStorage"] && isPersistent;

        if (initialData) {
            // クローン作成時: 渡されたデータをセット
            for (const [key, val] of Object.entries(initialData)) {
                this.mapCache.set(key, val);
            }
        } else {
            // 新規作成時 (System): デフォルト値をロード
            this.initDefaults();
        }
    }

    /**
     * 環境変数を取得
     */
    public get(strKey: string): string {
        return this.mapCache.get(strKey) || '';
    }

    /**
     * 環境変数を設定
     */
    public set(strKey: string, strValue: string): void {
        this.mapCache.set(strKey, strValue);
        
        // 永続化モードの場合のみストレージに書き込む
        if (this.isPersistent) {
            const strStorageKey = this.strNamespace + strKey;
            localStorage.setItem(strStorageKey, strValue);
        }
    }

    /**
     * 環境変数を削除
     */
    public unset(strKey: string): void {
        this.mapCache.delete(strKey);
        
        if (this.isPersistent) {
            localStorage.removeItem(this.strNamespace + strKey);
        }
    }

    /**
     * 全リスト取得 (export用)
     */
    public listAll(): Record<string, string> {
        const objEnv: Record<string, string> = {};
        for (const [key, val] of this.mapCache.entries()) {
            objEnv[key] = val;
        }
        return objEnv;
    }

    /**
     * [New] クローン作成 (for Child Process)
     * 現在の状態をコピーした、非永続的(In-Memory)なインスタンスを返す。
     */
    public clone(): IEnvManager {
        // 自分自身のコピーを渡し、isPersistent=false で作成
        return new EnvManager(this.listAll());
    }

    /**
     * [Internal: Init]
     * システム起動時のデフォルト値ロード
     */
    private initDefaults(): void {
        // localStorage から既存の値を復元 (永続化モード時のみ)
        if (this.isPersistent) {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(this.strNamespace)) {
                    const envKey = key.slice(this.strNamespace.length);
                    const val = localStorage.getItem(key);
                    if (val) this.mapCache.set(envKey, val);
                }
            }
        }

        // 必須変数の確保 (なければセット)
        const ensure = (key: string, val: string) => {
            if (!this.mapCache.has(key)) {
                this.set(key, val);
            }
        };

        ensure(EnvKey.Path, '/usr/bin:/bin');
        ensure(EnvKey.User, 'geek');
        ensure(EnvKey.Home, '/home/geek');
        ensure(EnvKey.Term, 'xterm-256color');
        ensure(EnvKey.Prompt, 'geek@kinbro $ ');
        ensure(EnvKey.Lang, 'ja_JP.UTF-8');
    }
}